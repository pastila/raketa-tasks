import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GitLabTasks} from './gitlab.js';

const GROUP_TITLES = {
    inprogress: '🔄 В работе',
    todo: '📋 TODO',
    codereview: '👀 Code review',
    testing: '🧪 Тестирование',
    approval: '🤝 Сбор апрувов',
    other: '👁️ Остальное',
};

function openUri(uri) {
    try {
        Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
    } catch (e) {
        Main.notifyError('Raketa Tasks', `Не удалось открыть ${uri}: ${e.message}`);
    }
}

// The P::High label carries the 🔥 in its own title; P::2 and below get no badge
function priorityBadge(priority) {
    if (priority?.startsWith('P::High'))
        return '🔥';
    if (priority === 'P::1')
        return '1️⃣';
    return null;
}

function unresolvedThreads(task) {
    return task.mrs.reduce((sum, mr) => sum + mr.unresolvedThreads, 0);
}

function mrLine(mr) {
    let text = `MR !${mr.iid}`;
    if (mr.draft)
        text += ' (draft)';
    if (mr.state === 'merged')
        text += ' · merged';
    else if (mr.approved)
        text += ` · апрувнут ✅ (${mr.approvals})`;
    else
        text += ` · апрувов ${mr.approvals}, осталось ${mr.approvalsLeft}`;
    if (mr.pendingSections.length > 0)
        text += ` · ждём: ${mr.pendingSections.join(', ')}`;
    if (mr.unresolvedThreads > 0)
        text += ` · 🚨 треды: ${mr.unresolvedThreads}`;
    return text;
}

const TasksIndicator = GObject.registerClass(
class TasksIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Raketa Tasks');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._gitlab = new GitLabTasks();
        this._cancellable = null;
        this._timerId = 0;
        this._data = null;
        this._error = null;
        this._updatedAt = null;
        this._loading = false;
        this._previous = null;
        this._notificationSource = null;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._countLabel = new St.Label({text: '🚀 …', y_align: Clutter.ActorAlign.CENTER});
        this._alertLabel = new St.Label({
            style_class: 'raketa-tasks-alert',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(this._countLabel);
        box.add_child(this._alertLabel);
        this.add_child(box);

        this._settingsChangedIds = [
            this._settings.connect('changed::refresh-interval', () => this._restartTimer()),
            ...['gitlab-host', 'project-path', 'team'].map(key =>
                this._settings.connect(`changed::${key}`, () => this.refresh())),
        ];

        this._menuDirty = false;
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (!isOpen && this._menuDirty)
                this._rebuildMenu();
        });

        this._rebuildMenu();
        this._restartTimer();
        this.refresh();
    }

    _restartTimer() {
        if (this._timerId)
            GLib.Source.remove(this._timerId);
        const minutes = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async refresh() {
        if (this._loading)
            return;
        this._loading = true;
        this._cancellable = new Gio.Cancellable();
        this._updatePanel();

        try {
            const data = await this._gitlab.fetch(this._source(), this._cancellable);
            this._data = data;
            this._error = null;
            this._updatedAt = GLib.DateTime.new_now_local();
            this._notifyChanges(data);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._error = e.message;
            console.warn(`Raketa Tasks: ${e.message}`);
        } finally {
            this._loading = false;
            this._cancellable = null;
        }

        this._updatePanel();
        this._rebuildMenu();
    }

    _source() {
        return {
            host: this._settings.get_string('gitlab-host'),
            project: this._settings.get_string('project-path'),
            team: this._settings.get_string('team'),
        };
    }

    _allTasks() {
        return this._data ? this._data.groups.flatMap(group => group.tasks) : [];
    }

    _updatePanel() {
        if (this._loading && !this._data) {
            this._countLabel.text = '🚀 …';
            return;
        }
        if (this._error && !this._data) {
            this._countLabel.text = '🚀 ⚠';
            this._alertLabel.visible = false;
            return;
        }
        this._countLabel.text = `🚀 ${this._data.total}${this._error ? ' ⚠' : ''}`;

        const threads = this._allTasks().reduce((sum, task) => sum + unresolvedThreads(task), 0);
        this._alertLabel.text = `🚨 ${threads}`;
        this._alertLabel.visible = threads > 0;
    }

    _rebuildMenu() {
        // A background refresh must not collapse the menu under the cursor
        if (this.menu.isOpen) {
            this._menuDirty = true;
            return;
        }
        this._menuDirty = false;
        this.menu.removeAll();

        const header = new PopupMenu.PopupMenuItem(this._headerText(), {reactive: false});
        header.label.add_style_class_name('raketa-tasks-detail');
        this.menu.addMenuItem(header);

        if (this._error) {
            const error = new PopupMenu.PopupMenuItem(`⚠ ${this._error}`, {reactive: false});
            error.label.add_style_class_name('raketa-tasks-error');
            error.label.clutter_text.line_wrap = true;
            this.menu.addMenuItem(error);
        }

        for (const group of this._data?.groups ?? []) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const title = new PopupMenu.PopupMenuItem(
                `${GROUP_TITLES[group.key] ?? group.key} · ${group.tasks.length}`, {reactive: false});
            title.label.add_style_class_name('raketa-tasks-group');
            this.menu.addMenuItem(title);

            for (const task of group.tasks)
                this.menu.addMenuItem(this._taskItem(task));
        }

        if (this._data && this._data.total === 0)
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem('✨ Активных задач нет', {reactive: false}));

        if (this._data?.stats)
            this._addStats(this._data.stats);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Обновить', () => this.refresh(), 'view-refresh-symbolic');
        if (this._data?.username) {
            const {host, project, team} = this._source();
            const url = `https://${host}/${project}/-/issues?assignee_username=${encodeURIComponent(this._data.username)}` +
                `&label_name[]=${encodeURIComponent(team)}`;
            this.menu.addAction('Все мои задачи в GitLab', () => openUri(url), 'web-browser-symbolic');
        }
        this.menu.addAction('Настройки', () => this._extension.openPreferences(), 'preferences-system-symbolic');
    }

    _addStats({week, month}) {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const title = new PopupMenu.PopupMenuItem('📊 Закрыто задач · смержено MR', {reactive: false});
        title.label.add_style_class_name('raketa-tasks-group');
        this.menu.addMenuItem(title);

        for (const [period, counts] of [['7 дней', week], ['30 дней', month]]) {
            const line = new PopupMenu.PopupMenuItem(
                `За ${period}: задач ${counts.closed} · MR ${counts.merged}`, {reactive: false});
            line.label.add_style_class_name('raketa-tasks-detail');
            this.menu.addMenuItem(line);
        }
    }

    _headerText() {
        if (this._loading && !this._updatedAt)
            return 'Загружаю задачи…';
        if (!this._updatedAt)
            return `Задачи ${this._settings.get_string('team')}`;
        return `Задачи ${this._settings.get_string('team')} · обновлено ${this._updatedAt.format('%H:%M')}`;
    }

    _taskItem(task) {
        // Badges go before the title: a long title is ellipsized at the end
        const badges = [];
        const priority = priorityBadge(task.priority);
        if (priority)
            badges.push(priority);
        const threads = unresolvedThreads(task);
        if (threads > 0)
            badges.push(`🚨${threads}`);
        if (task.hacks.length > 0)
            badges.push(task.hacks.some(hack => hack.mustRemove) ? '🏑🚨' : '🏑');
        if (task.mrs.length > 0 && task.mrs.every(mr => mr.approved || mr.state === 'merged'))
            badges.push('✅');

        const item = new PopupMenu.PopupSubMenuMenuItem([`#${task.iid}`, ...badges, ` ${task.title}`].join(' '));
        item.label.add_style_class_name('raketa-tasks-title');
        item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const detail = text => {
            const line = new PopupMenu.PopupMenuItem(text, {reactive: false});
            line.label.add_style_class_name('raketa-tasks-detail');
            item.menu.addMenuItem(line);
        };

        detail(`Статус: ${task.status}${task.priority ? ` · ${task.priority}` : ''}`);
        for (const hack of task.hacks)
            detail(hack.mustRemove ? `🚨 ${hack.label} — убрать перед мержем` : `⚠️ ${hack.label} — проверить перед мержем`);

        if (task.mrs.length === 0)
            detail('MR: нет');
        for (const mr of task.mrs)
            item.menu.addAction(mrLine(mr), () => openUri(mr.url));

        item.menu.addAction(`Открыть задачу #${task.iid}`, () => openUri(task.url));
        item.menu.addAction('Скопировать номер', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, task.iid);
        });

        return item;
    }

    _notifyChanges(data) {
        const current = new Map(data.groups.flatMap(group => group.tasks).map(task => [task.iid, task]));
        const previous = this._previous;
        this._previous = current;

        if (!previous || !this._settings.get_boolean('notify-changes'))
            return;

        for (const [iid, task] of current) {
            const before = previous.get(iid);
            if (!before) {
                this._notify(`Новая задача #${iid}`, task.title, task.url);
                continue;
            }
            if (before.status !== task.status)
                this._notify(`#${iid}: ${task.status}`, `${before.status} → ${task.status}\n${task.title}`, task.url);

            for (const mr of task.mrs) {
                const mrBefore = before.mrs.find(m => m.iid === mr.iid);
                if (mr.unresolvedThreads > (mrBefore?.unresolvedThreads ?? 0))
                    this._notify(`#${iid}: новые треды в MR !${mr.iid}`, `Неразрешённых: ${mr.unresolvedThreads}`, mr.url);
                if (mr.approved && mrBefore && !mrBefore.approved)
                    this._notify(`#${iid}: MR !${mr.iid} апрувнут ✅`, task.title, mr.url);
            }
        }
    }

    _notify(title, body, url) {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({
                title: 'Raketa Tasks',
                iconName: 'emblem-important-symbolic',
            });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }

        const notification = new MessageTray.Notification({source: this._notificationSource, title, body});
        notification.connect('activated', () => openUri(url));
        this._notificationSource.addNotification(notification);
    }

    destroy() {
        this._cancellable?.cancel();
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._settingsChangedIds.forEach(id => this._settings.disconnect(id));
        this._notificationSource?.destroy();
        super.destroy();
    }
});

export default class RaketaTasksExtension extends Extension {
    enable() {
        this._indicator = new TasksIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
