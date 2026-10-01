import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {lookupToken, storeToken} from './mattermost.js';

export default class RaketaTasksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Raketa Tasks',
            description: 'Задачи запрашиваются через glab api — glab должен быть залогинен на этот хост.',
        });

        for (const [key, title] of [['gitlab-host', 'Хост GitLab'], ['project-path', 'Проект'], ['team', 'Команда (лейбл)']]) {
            const row = new Adw.EntryRow({title});
            settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }

        const interval = new Adw.SpinRow({
            title: 'Интервал обновления',
            subtitle: 'в минутах',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1}),
        });
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const notify = new Adw.SwitchRow({
            title: 'Уведомления об изменениях',
            subtitle: 'Новая задача, смена статуса, новые треды, апрув MR, начало ревью',
        });
        settings.bind('notify-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(notify);

        page.add(group);
        page.add(this._mattermostGroup(settings, window));
        window.add(page);
    }

    _mattermostGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Mattermost',
            description: 'Запросы апрува — ваши сообщения со ссылкой на MR в каналах ревью, реакции на них — ход ревью. ' +
                'Только чтение. ' +
                'Токен — значение cookie MMAUTHTOKEN из браузера, хранится в keyring.',
        });

        const url = new Adw.EntryRow({title: 'Сервер (пусто — выключено)'});
        settings.bind('mattermost-url', url, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(url);

        for (const [key, title] of [
            ['mattermost-channels', 'Каналы через запятую (имя из URL канала)'],
            ['mattermost-review-emoji', 'Реакции «начал ревью» через запятую (eyes)'],
            ['mattermost-approve-emoji', 'Реакции «апрувнул» через запятую (white_check_mark)'],
        ]) {
            const row = new Adw.EntryRow({title});
            row.text = settings.get_strv(key).join(', ');
            row.connect('changed', () => settings.set_strv(key,
                row.text.split(',').map(name => name.trim().replace(/^:|:$/g, '')).filter(name => name !== '')));
            group.add(row);
        }

        const days = new Adw.SpinRow({
            title: 'Глубина поиска',
            subtitle: 'в днях',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 180, step_increment: 1}),
        });
        settings.bind('mattermost-days', days, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(days);

        const token = new Adw.PasswordEntryRow({title: 'Токен MMAUTHTOKEN', show_apply_button: true});
        const serverUrl = () => settings.get_string('mattermost-url').trim().replace(/\/+$/, '');
        const showState = () => lookupToken(serverUrl(), null)
            .then(saved => (token.title = saved ? 'Токен MMAUTHTOKEN (сохранён)' : 'Токен MMAUTHTOKEN (не задан)'))
            .catch(e => (token.title = `Токен MMAUTHTOKEN (keyring: ${e.message})`));
        token.connect('apply', () => {
            storeToken(serverUrl(), token.text.trim(), null)
                .then(() => {
                    window.add_toast(new Adw.Toast({title: token.text.trim() ? 'Токен сохранён' : 'Токен удалён'}));
                    token.text = '';
                    showState();
                })
                .catch(e => window.add_toast(new Adw.Toast({title: `Не удалось сохранить: ${e.message}`})));
        });
        const urlChangedId = settings.connect('changed::mattermost-url', showState);
        window.connect('close-request', () => settings.disconnect(urlChangedId));
        showState();
        group.add(token);

        return group;
    }
}
