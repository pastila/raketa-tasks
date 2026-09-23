# Raketa Tasks — GNOME Shell extension

Кнопка в верхней панели со списком моих задач Raccoons из GitLab, сгруппированных
по статусу (В работе → TODO → Code review → Тестирование → Сбор апрувов → Остальное). Перед
названием — значок приоритета (🔥 P::High, 1️⃣ P::1), у каждой задачи — статус, приоритет,
костыли, MR с апрувами и неразрешёнными тредами.

- В панели: `🚀 8` — активных задач, `🚨 3` — неразрешённых тредов в неапрувнутых MR.
- Бейджи у задачи: `🚨N` треды, `🏑` костыль (`🏑🚨` — костыль для тестов, убрать перед мержем), `✅` все MR апрувнуты.
- У неапрувнутого MR — секции CODEOWNERS, чей апрув ещё нужен: `ждём: SavageBeavers, QA`. Секция закрыта, когда
  закрыты все её правила, — так же считает GitLab (апрув от любого владельца пути, включая соседние группы).
- Клик по MR / «Открыть задачу» — браузер; «Скопировать номер» — в буфер.
- Уведомления: новая задача, смена статуса, новые треды, апрув MR (клик по уведомлению открывает ссылку).
- Статистика в меню за скользящие 7 и 30 дней: сколько задач команды закрыто (вы среди исполнителей)
  и сколько ваших MR смержено. Задача закрывается при мерже MR, а не после тестирования; задачи,
  где вы соисполнитель, тоже считаются.
- Обновление раз в N минут (по умолчанию 5) и пунктом «Обновить».

## Откуда данные

Расширение самодостаточно: `gitlab.js` вызывает `glab api --hostname <хост>` (токен glab из keyring)
— сначала `user`, чтобы узнать логин, затем один GraphQL-запрос за открытыми work items с лейблом
команды, их лейблами и `closingMergeRequests` (с правилами апрува `approvalState.rules`); в том же
запросе — `count` закрытых задач (`closedAfter`) и смерженных MR (`mergedAfter`) для статистики.
Правила группировки — в `groupOf()` / `toTask()`.

`--hostname` обязателен: вне git-репозитория (а gnome-shell работает из `~`) glab по умолчанию
идёт на gitlab.com и получает 401.

Хост, проект и команда (лейбл и префикс статусов `>_Команда::…`) — в настройках.

## Установка

Нужны GNOME Shell 46 и [`glab`](https://gitlab.com/gitlab-org/cli) — GitLab CLI:

- `glab` должен быть установлен и залогинен на хост из настроек: `glab auth login --hostname <хост GitLab>`,
  проверка — `glab auth status --hostname <хост GitLab>`. Токен берёт сам glab,
  расширение его не хранит и не читает.
- `glab` ищется в `PATH` процесса gnome-shell, а не терминала. Если он лежит в `~/.local/bin`, `~/go/bin`,
  Homebrew и т.п., shell может его не увидеть — поставьте `glab` в системный каталог (`/usr/bin`,
  `/usr/local/bin`) или сделайте туда симлинк.
- Без `glab` расширение не падает: в панели `🚀 ⚠`, в меню — текст ошибки, попытка повторяется по таймеру.

```bash
make install     # компилирует схему и симлинкает каталог в ~/.local/share/gnome-shell/extensions
# X11: Alt+F2 → r → Enter; Wayland: выйти и зайти
make enable
```

Настройки: пункт «Настройки» в меню или `gnome-extensions prefs raketa-tasks@pastila`.

### Команды make

| Команда | Что делает |
|---|---|
| `make schemas` | Компилирует `schemas/*.gschema.xml` в `schemas/gschemas.compiled` (`glib-compile-schemas`). Нужна после правки схемы настроек; `install` и `pack` вызывают её сами. |
| `make install` | `schemas` + симлинк рабочего каталога в `~/.local/share/gnome-shell/extensions/raketa-tasks@pastila`. Shell подхватит расширение после перезапуска (X11: Alt+F2 → r; Wayland: перелогиниться). |
| `make enable` | Включает расширение (`gnome-extensions enable`). |
| `make uninstall` | Выключает расширение (ошибка игнорируется, если оно уже выключено) и удаляет симлинк. Сохранённые настройки остаются в dconf. |
| `make pack` | `schemas` + собирает `raketa-tasks@pastila.shell-extension.zip` (`gnome-extensions pack`, с `gitlab.js` и схемой). Архив ставится без симлинка: `gnome-extensions install --force raketa-tasks@pastila.shell-extension.zip`. В git не попадает. |
| `make logs` | Следит за журналом gnome-shell (`journalctl --user -f`) и показывает строки, где есть «raketa»: `console.warn` расширения и JS-ошибки с путём к его файлам. Выход — Ctrl+C. |

## Разработка

Каталог установлен симлинком, так что после правки достаточно перезапустить shell (X11: Alt+F2 → r).
Логи: `make logs` (`console.warn` расширения и ошибки JS).

Проверить без перезапуска своей сессии можно в отдельном headless-shell:

```bash
dbus-run-session -- gnome-shell --headless --wayland --no-x11 --virtual-monitor 1600x1000
```

с `XDG_DATA_HOME`/`XDG_CONFIG_HOME` во временном каталоге, `GSETTINGS_BACKEND=keyfile` и коротким
`XDG_RUNTIME_DIR` (путь к wayland-сокету ≤ 108 байт). Keyring там недоступен, поэтому в `PATH` кладётся фейковый
`glab`, отдающий сохранённые ответы `user` и `graphql`. Для `org.gnome.Shell.Eval` нужен
unsafe-mode — его включает вспомогательное расширение с `global.context.unsafe_mode = true`;
в Eval доступен `Main` (`Main.panel.statusArea['raketa-tasks@pastila']`).
