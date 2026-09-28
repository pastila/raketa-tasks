import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const GLAB_TIMEOUT_SECONDS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

const TASKS_QUERY = `
fragment MrInfo on MergeRequest {
  iid
  state
  draft
  webUrl
  approved
  approvalsLeft
  approvedBy { nodes { username } }
  resolvableDiscussionsCount
  resolvedDiscussionsCount
  approvalState { rules { type section approved approvalsRequired } }
  headPipeline { status path }
}
query($project: ID!, $username: String!, $label: String!, $weekAgo: Time!, $monthAgo: Time!) {
  project(fullPath: $project) {
    closedWeek: workItems(assigneeUsernames: [$username], labelName: [$label], state: closed, closedAfter: $weekAgo) { count }
    closedMonth: workItems(assigneeUsernames: [$username], labelName: [$label], state: closed, closedAfter: $monthAgo) { count }
    mergedWeek: mergeRequests(authorUsername: $username, state: merged, mergedAfter: $weekAgo) { count }
    mergedMonth: mergeRequests(authorUsername: $username, state: merged, mergedAfter: $monthAgo) { count }
    workItems(assigneeUsernames: [$username], labelName: [$label], state: opened, first: 100) {
      nodes {
        iid
        title
        webUrl
        widgets {
          ... on WorkItemWidgetLabels {
            labels { nodes { title } }
          }
          ... on WorkItemWidgetDevelopment {
            closingMergeRequests { nodes { mergeRequest { ...MrInfo } } }
          }
        }
      }
    }
  }
}`;

export const GROUP_KEYS = ['inprogress', 'rework', 'todo', 'codereview', 'testing', 'approval', 'other'];

/**
 * Runs `glab api --hostname HOST ...` and returns the parsed JSON.
 * The hostname is explicit: outside a git checkout glab falls back to gitlab.com.
 */
async function glabApi(host, args, cancellable) {
    const proc = new Gio.Subprocess({
        argv: ['glab', 'api', '--hostname', host, ...args],
        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    });
    try {
        proc.init(cancellable);
    } catch (e) {
        if (e.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT))
            throw new Error(`glab не найден в PATH gnome-shell — установите glab и выполните glab auth login --hostname ${host}`);
        throw e;
    }

    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, GLAB_TIMEOUT_SECONDS, () => {
        proc.force_exit();
        return GLib.SOURCE_REMOVE;
    });
    try {
        const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
        if (!proc.get_successful()) {
            const reason = stderr.trim().split('\n').pop() || `glab: код выхода ${proc.get_exit_status()}`;
            throw new Error(reason);
        }
        const response = JSON.parse(stdout);
        if (response.errors?.length)
            throw new Error(response.errors.map(error => error.message).join('; '));
        return response;
    } finally {
        GLib.Source.remove(timeoutId);
    }
}

function groupOf(statuses, team) {
    if (statuses.includes(`>_${team}::InProgress`))
        return 'inprogress';
    // Вернули на доработку (после ревью или тестирования) — следующая на очереди после текущей
    if (statuses.includes(`>_${team}::ReadyForRework`))
        return 'rework';
    if (statuses.includes(`>_${team}::TODO`) || statuses.length === 0)
        return 'todo';
    if (statuses.includes(`>_${team}::CodeReview`))
        return 'codereview';
    if (statuses.some(status => status.startsWith('>_Testing')))
        return 'testing';
    // Приёмка перед деплоем — лейбл общий, без префикса команды
    if (statuses.includes('>_Approval'))
        return 'approval';
    return 'other';
}

/**
 * CODEOWNERS sections still waiting for approval, in rule order. A section holds one rule per path
 * pattern, so it is pending while any of its required rules is not approved.
 */
function pendingSections(mr) {
    const sections = (mr.approvalState?.rules ?? [])
        .filter(rule => rule.type === 'CODE_OWNER' && rule.approvalsRequired > 0 && !rule.approved)
        .map(rule => rule.section ?? '—');
    return [...new Set(sections)];
}

// Last pipeline of the MR's source branch; only a finished failure counts, a rerun in progress clears it
function failedPipelineUrl(mr, host) {
    if (mr.state !== 'opened' || mr.headPipeline?.status !== 'FAILED')
        return null;
    return `https://${host}${mr.headPipeline.path}`;
}

function toTask(node, team, host) {
    const labels = node.widgets.flatMap(widget => widget.labels?.nodes.map(label => label.title) ?? []);
    if (labels.includes(`>_${team}::Done`))
        return null;

    const mrs = new Map();
    for (const widget of node.widgets) {
        for (const {mergeRequest: mr} of widget.closingMergeRequests?.nodes ?? []) {
            if (!mr || mr.state === 'closed' || mrs.has(mr.iid))
                continue;
            const open = (mr.resolvableDiscussionsCount ?? 0) - (mr.resolvedDiscussionsCount ?? 0);
            mrs.set(mr.iid, {
                iid: mr.iid,
                url: mr.webUrl,
                state: mr.state,
                draft: mr.draft,
                approved: mr.approved,
                // approvalsRequired sums every rule, and one approver can satisfy several code-owner rules,
                // so "given/required" is misleading — approvalsLeft is what GitLab actually waits for
                approvalsLeft: mr.approvalsLeft ?? 0,
                approvals: mr.approvedBy.nodes.length,
                unresolvedThreads: mr.state === 'opened' && !mr.approved ? Math.max(open, 0) : 0,
                pendingSections: mr.state === 'opened' && !mr.approved ? pendingSections(mr) : [],
                failedPipelineUrl: failedPipelineUrl(mr, host),
            });
        }
    }

    const statuses = labels.filter(label => label.startsWith('>_'));
    const priority = labels.find(label => label.startsWith('P::')) ?? null;
    return {
        iid: node.iid,
        title: node.title,
        url: node.webUrl,
        priority,
        status: statuses.length > 0 ? statuses.join(', ') : '—',
        group: groupOf(statuses, team),
        hacks: labels.filter(label => label.startsWith('Костыль'))
            .map(label => ({label, mustRemove: label.includes('для тестов')})),
        mrs: [...mrs.values()],
    };
}

export class GitLabTasks {
    constructor() {
        this._username = null;
        this._usernameHost = null;
    }

    /**
     * Open work items of the glab user with the team label, grouped by status:
     * InProgress → ReadyForRework → TODO → CodeReview → Testing → Approval → other; Done is skipped.
     * Priority is not a group of its own — it shows as a badge on the task.
     */
    async fetch({host, project, team}, cancellable) {
        if (this._usernameHost !== host) {
            const user = await glabApi(host, ['user'], cancellable);
            this._username = user.username;
            this._usernameHost = host;
        }

        const response = await glabApi(host, [
            'graphql',
            '-f', `query=${TASKS_QUERY}`,
            '-f', `project=${project}`,
            '-f', `username=${this._username}`,
            '-f', `label=${team}`,
            '-f', `weekAgo=${new Date(Date.now() - 7 * DAY_MS).toISOString()}`,
            '-f', `monthAgo=${new Date(Date.now() - 30 * DAY_MS).toISOString()}`,
        ], cancellable);

        const projectData = response.data.project;
        const tasks = (projectData?.workItems.nodes ?? [])
            .map(node => toTask(node, team, host))
            .filter(task => task !== null);

        return {
            username: this._username,
            total: tasks.length,
            // Rolling windows; an issue closes when its MR is merged, not after testing
            stats: projectData ? {
                week: {closed: projectData.closedWeek.count, merged: projectData.mergedWeek.count},
                month: {closed: projectData.closedMonth.count, merged: projectData.mergedMonth.count},
            } : null,
            groups: GROUP_KEYS
                .map(key => ({key, tasks: tasks.filter(task => task.group === key)}))
                .filter(group => group.tasks.length > 0),
        };
    }
}
