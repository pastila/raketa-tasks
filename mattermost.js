import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
import Secret from 'gi://Secret';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 200;
const HTTP_TIMEOUT_SECONDS = 30;

// The session token (MMAUTHTOKEN cookie) lives in the keyring, keyed by the server URL
export const TOKEN_SCHEMA = new Secret.Schema('org.gnome.shell.extensions.raketa-tasks.mattermost',
    Secret.SchemaFlags.NONE, {url: Secret.SchemaAttributeType.STRING});

export function lookupToken(url, cancellable) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(TOKEN_SCHEMA, {url}, cancellable, (source, result) => {
            try {
                resolve(Secret.password_lookup_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function storeToken(url, token, cancellable) {
    return new Promise((resolve, reject) => {
        const done = (source, result) => {
            try {
                resolve(token ? Secret.password_store_finish(result) : Secret.password_clear_finish(result));
            } catch (e) {
                reject(e);
            }
        };
        if (token)
            Secret.password_store(TOKEN_SCHEMA, {url}, Secret.COLLECTION_DEFAULT, `Raketa Tasks: Mattermost ${url}`,
                token, cancellable, done);
        else
            Secret.password_clear(TOKEN_SCHEMA, {url}, cancellable, done);
    });
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Approval requests for MRs: my own posts in the review channels that link a merge request.
 * Read-only by design — every call is a GET, nothing is ever posted to Mattermost.
 *
 * The first refresh pages back through each channel down to the cutoff, later ones only ask for
 * posts changed since the previous refresh (`since` also returns edited and deleted posts).
 */
export class MattermostRequests {
    constructor() {
        this._http = new Soup.Session({timeout: HTTP_TIMEOUT_SECONDS});
        this._reset(null);
    }

    _reset(key) {
        this._key = key;
        this._me = null;
        this._channels = null;
        this._posts = new Map();
        this._syncedAt = new Map();
        this._users = new Map();
    }

    async _get(url, token, path, cancellable) {
        const message = Soup.Message.new('GET', `${url}/api/v4${path}`);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        const bytes = await this._http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
        const status = message.get_status();
        if (status === Soup.Status.UNAUTHORIZED)
            throw new Error('Mattermost: токен недействителен — обновите MMAUTHTOKEN в настройках');
        const body = new TextDecoder().decode(bytes.toArray());
        if (status !== Soup.Status.OK)
            throw new Error(`Mattermost ${path}: HTTP ${status} ${JSON.parse(body || '{}').message ?? ''}`.trim());
        return JSON.parse(body);
    }

    /** Review channels by name across my teams; a name missing from every team is reported. */
    async _resolveChannels(url, token, names, cancellable) {
        const teams = await this._get(url, token, '/users/me/teams', cancellable);
        const channels = [];
        for (const team of teams) {
            const mine = await this._get(url, token, `/users/me/teams/${team.id}/channels`, cancellable);
            for (const channel of mine.filter(c => names.includes(c.name)))
                channels.push({id: channel.id, name: channel.name, team: team.name});
        }
        const missing = names.filter(name => !channels.some(channel => channel.name === name));
        if (missing.length > 0)
            console.warn(`Raketa Tasks: каналы Mattermost не найдены среди ваших: ${missing.join(', ')}`);
        return channels;
    }

    _remember(channel, post) {
        if (post.delete_at > 0 || post.user_id !== this._me)
            this._posts.delete(post.id);
        else
            this._posts.set(post.id, {
                id: post.id,
                channel,
                createAt: post.create_at,
                message: post.message,
                // Reactions come inline, and adding one bumps the post's update_at, so `since` sees it
                reactions: (post.metadata?.reactions ?? [])
                    .filter(reaction => reaction.user_id !== this._me)
                    .map(reaction => ({emoji: reaction.emoji_name, userId: reaction.user_id, createAt: reaction.create_at})),
            });
    }

    /** Display name for a user id: full name, else username; cached for the session. */
    async _userName(url, token, userId, cancellable) {
        if (!this._users.has(userId)) {
            const user = await this._get(url, token, `/users/${userId}`, cancellable);
            this._users.set(userId, `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.username);
        }
        return this._users.get(userId);
    }

    /** Reactions from the given emoji list, one per user (the earliest), oldest first. */
    async _reactionsOf(url, token, post, emoji, cancellable) {
        const byUser = new Map();
        for (const reaction of post.reactions.filter(r => emoji.includes(r.emoji))) {
            if (!byUser.has(reaction.userId) || byUser.get(reaction.userId).createAt > reaction.createAt)
                byUser.set(reaction.userId, reaction);
        }
        const reactions = [];
        for (const reaction of byUser.values()) {
            reactions.push({
                userId: reaction.userId,
                user: await this._userName(url, token, reaction.userId, cancellable),
                createAt: reaction.createAt,
            });
        }
        return reactions.sort((a, b) => a.createAt - b.createAt);
    }

    async _syncChannel(url, token, channel, cutoff, cancellable) {
        const startedAt = Date.now();
        const since = this._syncedAt.get(channel.id);
        if (since) {
            const page = await this._get(url, token, `/channels/${channel.id}/posts?since=${since}`, cancellable);
            Object.values(page.posts ?? {}).forEach(post => this._remember(channel, post));
        } else {
            for (let n = 0; ; n++) {
                const page = await this._get(url, token,
                    `/channels/${channel.id}/posts?page=${n}&per_page=${PAGE_SIZE}`, cancellable);
                const posts = page.order.map(id => page.posts[id]);
                posts.forEach(post => this._remember(channel, post));
                if (posts.length < PAGE_SIZE || posts.some(post => post.create_at < cutoff))
                    break;
            }
        }
        // A little overlap against clock skew between us and the server
        this._syncedAt.set(channel.id, startedAt - 60 * 1000);
    }

    /**
     * Map MR iid → my posts linking it, newest first:
     * [{channel, createAt, permalink, reviews, approvals}], where permalink opens the post in Mattermost,
     * reviews / approvals — [{userId, user, createAt}] from reactions with reviewEmoji / approveEmoji.
     */
    async fetch({url, channels, days, gitlabHost, project, reviewEmoji, approveEmoji}, cancellable) {
        url = url.replace(/\/+$/, '');
        const key = JSON.stringify([url, channels]);
        if (key !== this._key)
            this._reset(key);

        const token = await lookupToken(url, cancellable);
        if (!token)
            throw new Error('Mattermost: нет токена — вставьте MMAUTHTOKEN в настройках');

        try {
            this._me ??= (await this._get(url, token, '/users/me', cancellable)).id;
            this._channels ??= await this._resolveChannels(url, token, channels, cancellable);
            const cutoff = Date.now() - days * DAY_MS;
            for (const channel of this._channels)
                await this._syncChannel(url, token, channel, cutoff, cancellable);
        } catch (e) {
            // A fresh token (or a half-done first sync) must start over with a full sync
            this._reset(null);
            throw e;
        }

        const mrLink = new RegExp(`${escapeRegExp(gitlabHost)}/${escapeRegExp(project)}/-/merge_requests/(\\d+)`, 'g');
        const cutoff = Date.now() - days * DAY_MS;
        const requests = new Map();
        for (const post of this._posts.values()) {
            if (post.createAt < cutoff) {
                this._posts.delete(post.id);
                continue;
            }
            const iids = new Set([...post.message.matchAll(mrLink)].map(match => match[1]));
            if (iids.size === 0)
                continue;
            const reviews = await this._reactionsOf(url, token, post, reviewEmoji, cancellable);
            const approvals = await this._reactionsOf(url, token, post, approveEmoji, cancellable);
            for (const iid of iids) {
                if (!requests.has(iid))
                    requests.set(iid, []);
                requests.get(iid).push({
                    channel: post.channel.name,
                    createAt: post.createAt,
                    permalink: `${url}/${post.channel.team}/pl/${post.id}`,
                    reviews,
                    approvals,
                });
            }
        }
        for (const list of requests.values())
            list.sort((a, b) => b.createAt - a.createAt);
        return requests;
    }

    destroy() {
        this._http.abort();
    }
}
