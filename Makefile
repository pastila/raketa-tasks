UUID := raketa-tasks@pastila
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES := metadata.json extension.js gitlab.js mattermost.js prefs.js stylesheet.css schemas

.PHONY: install enable uninstall pack schemas logs

schemas:
	glib-compile-schemas schemas/

# Symlink the working copy, so edits only need a shell restart
install: schemas
	mkdir -p $(dir $(DEST))
	ln -sfn $(CURDIR) $(DEST)
	@echo "Установлено. X11: Alt+F2 → r → Enter; Wayland: перелогиниться. Потом: make enable"

enable:
	gnome-extensions enable $(UUID)

uninstall:
	-gnome-extensions disable $(UUID)
	rm -f $(DEST)

pack: schemas
	gnome-extensions pack --force --extra-source=gitlab.js --extra-source=mattermost.js --schema=schemas/org.gnome.shell.extensions.raketa-tasks.gschema.xml .

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell | grep --line-buffered -i raketa
