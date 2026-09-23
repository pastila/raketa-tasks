import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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
            subtitle: 'Новая задача, смена статуса, новые треды, апрув MR',
        });
        settings.bind('notify-changes', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(notify);

        page.add(group);
        window.add(page);
    }
}
