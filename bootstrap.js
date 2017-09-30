const ADDON_ID = "cookiepsycho@qdnx.org";
const ADDON_PREF_PAGE = "addons://detail/cookiepsycho@qdnx.org/preferences";

const BROWSER_WINDOW_TYPE = "navigator:browser";
const BROWSER_WINDOW_URL = "chrome://browser/content/browser.xul";

const PREF_BRANCH = "extensions.cookiepsycho.";
const PREF_DELETE_EXPIRED_COUNT = "deleteExpired.count";
const PREF_DELETE_EXPIRED_ENABLED = "deleteExpired.enabled";
const PREF_DELETE_UNUSED_COUNT = "deleteUnused.count";
const PREF_DELETE_UNUSED_DAYS = "deleteUnused.days";
const PREF_EXPIRE_COUNT = "expire.count";
const PREF_EXPIRE_DAYS = "expire.days";
const PREF_IDLE_ENABLED = "idle.enabled";
const PREF_IDLE_LASTRAN = "idle.lastran";

const SECONDS_IN_DAY = 86400;
const MS_IN_SECOND = 1000;
const US_IN_SECOND = 1000000;

const DAY_INCREMENTS_SHORT = [7, 14, 30, 60, 91, 182, 273, 365, 547];
const DAY_INCREMENTS_LONG = [7, 14, 30, 60, 91, 182, 273, 365, 547, 730, 1095, 1825];

Components.utils.import("resource://gre/modules/Promise.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/Sqlite.jsm");
Components.utils.import("resource://gre/modules/Task.jsm");
Components.utils.import("resource://gre/modules/PluralForm.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "strings", function() Services.strings.createBundle("chrome://cookiepsycho/locale/cookiepsycho.properties"));
XPCOMUtils.defineLazyGetter(this, "getPlural", function() PluralForm.makeGetter(strings.GetStringFromName("pluralForm"))[0]);

let optionsObserver = {
	observe: function(aDocument, aTopic, aData) {
		switch(aTopic) {
		case "addon-options-displayed":
			if (aData != ADDON_ID) {
				return;
			}

			this.updateAffectedCounts(aDocument);

			aDocument.getElementById("cookiepsycho.runnow").addEventListener("command", () => {
				autoRunQueries().then(count => {
					let deleted = count.deleteExpired + count.deleteUnused;
					let modified = count.expire;
					aDocument.defaultView.alert(strings.formatStringFromName("message", [formatPlural(deleted), formatPlural(modified)], 2));
					this.updateAffectedCounts(aDocument);
				});
			});
		}
	},

	updateAffectedCounts: function(aDocument) {
		countQueries().then(result => {
			aDocument.getElementById("cookiepsycho.deleteExpired.enabled").setAttribute("desc", formatPlural(result.deleteExpired));
			let deleteUnusedItem = aDocument.getElementById("cookiepsycho.deleteUnused.days").querySelector("menuitem");
			for (let day in result.deleteUnused) {
				deleteUnusedItem.setAttribute("description", formatPlural(result.deleteUnused[day]));
				deleteUnusedItem = deleteUnusedItem.nextElementSibling;
			}
			let expireItem = aDocument.getElementById("cookiepsycho.expire.days").querySelector("menuitem");
			for (let day in result.expire) {
				expireItem.setAttribute("description", formatPlural(result.expire[day]));
				expireItem = expireItem.nextElementSibling;
			}
		});
	}
};

let idleObserver = {
	observe: function(aSubject, aTopic, aData) {
		switch(aTopic) {
		case "cookiepsycho-idle":
		case "idle-daily":
			if (Services.prefs.getBoolPref(PREF_BRANCH + PREF_IDLE_ENABLED)) {
				autoRunQueries().then(count => {
					let deleted = count.deleteExpired + count.deleteUnused;
					let modified = count.expire;
					Services.prefs.setIntPref(PREF_BRANCH + PREF_IDLE_LASTRAN, Math.floor(Date.now() / MS_IN_SECOND));
					Services.console.logStringMessage(aTopic + ": " + strings.formatStringFromName("message", [formatPlural(deleted), formatPlural(modified)], 2));
				});
			} else if (aTopic == "cookiepsycho-idle") {
				Services.console.logStringMessage(aTopic + ": " + strings.GetStringFromName("idle-disabled"));
			}
			break;
		}
	}
};

let windowHandler = {
	load: function() {
		this.enumerateWindows(this.paint);
		Services.ww.registerNotification(this);
	},
	unload: function(aReason) {
		Services.ww.unregisterNotification(this);
		if (aReason != APP_SHUTDOWN) {
			this.enumerateWindows(this.unpaint);
		}
	},
	enumerateWindows: function(aCallback) {
		let windowEnum = Services.wm.getEnumerator(BROWSER_WINDOW_TYPE);
		while (windowEnum.hasMoreElements()) {
			aCallback(windowEnum.getNext());
		}
	},
	observe: function(aSubject, aTopic, aData) {
		if (aTopic == "domwindowopened") {
			function onload() {
				aSubject.removeEventListener("load", onload);
				windowHandler.paint(aSubject);
			}
			aSubject.addEventListener("load", onload);
		} else {
			this.unpaint(aSubject);
		}
	},
	paint: function(aWindow) {
		if (aWindow.location.href != BROWSER_WINDOW_URL) {
			return;
		}

		let document = aWindow.document;
		let menuitem = document.createElement("menuitem");
		menuitem.id = "tools-cookiepsycho";
		menuitem.className = "menuitem-iconic";
		menuitem.setAttribute("label", strings.GetStringFromName("options.label"));
		menuitem.addEventListener("command", function() {
			windowHandler.openPreferences();
		});

		let toolsPopup = document.getElementById("menu_ToolsPopup");
		toolsPopup.appendChild(menuitem);
	},
	unpaint: function(aWindow) {
		if (aWindow.location.href != BROWSER_WINDOW_URL) {
			return;
		}

		let document = aWindow.document;
		document.getElementById("tools-cookiepsycho").remove();
	},
	showConfigMessage: function(aIcon) {
		let recentWindow = Services.wm.getMostRecentWindow(BROWSER_WINDOW_TYPE);
		if (!recentWindow) {
			return;
		}

		let label = strings.GetStringFromName("notification.label");
		let value = "notify-cookiepsycho";
		let buttons = [{
			label: strings.GetStringFromName("notification-button.label"),
			accessKey: strings.GetStringFromName("notification-button.accesskey"),
			callback: this.openPreferences
		}];

		let notifyBox = recentWindow.gBrowser.getNotificationBox();
		notifyBox.appendNotification(label, value, aIcon, notifyBox.PRIORITY_INFO_LOW, buttons);
	},
	openPreferences: function() {
		let browserWindow = Services.wm.getMostRecentWindow(BROWSER_WINDOW_TYPE);
		browserWindow.BrowserOpenAddonsMgr(ADDON_PREF_PAGE);
	}
};

function install(aParams, aReason) {
}

function uninstall(aParams, aReason) {
}

function startup(aParams, aReason) {
	let defaultPrefs = Services.prefs.getDefaultBranch(PREF_BRANCH);
	defaultPrefs.setIntPref(PREF_DELETE_EXPIRED_COUNT, 0);
	defaultPrefs.setBoolPref(PREF_DELETE_EXPIRED_ENABLED, true);
	defaultPrefs.setIntPref(PREF_DELETE_UNUSED_COUNT, 0);
	defaultPrefs.setIntPref(PREF_DELETE_UNUSED_DAYS, 90);
	defaultPrefs.setIntPref(PREF_EXPIRE_COUNT, 0);
	defaultPrefs.setIntPref(PREF_EXPIRE_DAYS, 90);
	defaultPrefs.setBoolPref(PREF_IDLE_ENABLED, false);

	Services.obs.addObserver(optionsObserver, "addon-options-displayed", false);
	Services.obs.addObserver(idleObserver, "idle-daily", false);
	Services.obs.addObserver(idleObserver, "cookiepsycho-idle", false);

	windowHandler.load();

	if (aReason == ADDON_INSTALL) {
		windowHandler.showConfigMessage(aParams.resourceURI.spec + "icon.png");
	}
}

function shutdown(aParams, aReason) {
	windowHandler.unload(aReason);

	if (aReason == APP_SHUTDOWN) {
		return;
	}

	Services.obs.removeObserver(optionsObserver, "addon-options-displayed");
	Services.obs.removeObserver(idleObserver, "idle-daily", false);
	Services.obs.removeObserver(idleObserver, "cookiepsycho-idle", false);
}

function autoRunQueries() {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let deleteExpired = Services.prefs.getBoolPref(PREF_BRANCH + PREF_DELETE_EXPIRED_ENABLED);
		let deleteUnusedDays = Services.prefs.getIntPref(PREF_BRANCH + PREF_DELETE_UNUSED_DAYS);
		let expireDays = Services.prefs.getIntPref(PREF_BRANCH + PREF_EXPIRE_DAYS);

		let count = yield countQueries();
		yield runQueries(deleteExpired, deleteUnusedDays, expireDays);

		let result = {
			deleteExpired: 0,
			deleteUnused: 0,
			expire: 0
		};

		if (deleteExpired) {
			increaseCount(PREF_DELETE_EXPIRED_COUNT, count.deleteExpired);
			result.deleteExpired = count.deleteExpired;
		}
		if (deleteUnusedDays) {
			increaseCount(PREF_DELETE_UNUSED_COUNT, count.deleteUnused[deleteUnusedDays]);
			result.deleteUnused = count.deleteUnused[deleteUnusedDays];
		}
		if (expireDays) {
			increaseCount(PREF_EXPIRE_COUNT, count.expire[expireDays]);
			result.expire = count.expire[expireDays];
		}

		deferred.resolve(result);
	});
	return deferred.promise;
}

function countQueries() {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let connection = yield Sqlite.openConnection({ path: "cookies.sqlite" });
		try {
			let results = {
				deleteExpired: 0,
				deleteUnused: {},
				expire: {}
			};
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE expiry < strftime('%s', 'now')";
				let result = yield connection.execute(sql);
				results.deleteExpired = result[0].getResultByIndex(0);
			}
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE lastAccessed < strftime('%s000000', 'now') - :us";
				for (let days of DAY_INCREMENTS_SHORT) {
					let params = { us: days * SECONDS_IN_DAY * US_IN_SECOND };
					let result = yield connection.executeCached(sql, params);
					results.deleteUnused[days] = yield result[0].getResultByIndex(0);
				}
			}
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE expiry > strftime('%s', 'now') + :s";
				for (let days of DAY_INCREMENTS_LONG) {
					let params = { s: days * SECONDS_IN_DAY };
					let result = yield connection.executeCached(sql, params);
					results.expire[days] = yield result[0].getResultByIndex(0);
				}
			}
			deferred.resolve(results);
		} catch (error) {
			deferred.reject(error);
		} finally {
			yield connection.close();
		}
	});
	return deferred.promise;
}

function runQueries(aDeleteExpired, aDeleteUnusedDays, aExpireDays) {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let connection = yield Sqlite.openConnection({ path: "cookies.sqlite" });
		try {
			if (aDeleteExpired) {
				let sql = "DELETE FROM moz_cookies WHERE expiry < strftime('%s', 'now')";
				yield connection.execute(sql);
			}
			if (aDeleteUnusedDays > 0) {
				let sql = "DELETE FROM moz_cookies WHERE lastAccessed < strftime('%s000000', 'now') - :us";
				let params = { us: aDeleteUnusedDays * SECONDS_IN_DAY * US_IN_SECOND };
				yield connection.execute(sql, params);
			}
			if (aExpireDays > 0) {
				let sql = "UPDATE moz_cookies SET expiry = MIN(strftime('%s', 'now') + :s, expiry)";
				let params = { s: aExpireDays * SECONDS_IN_DAY };
				yield connection.execute(sql, params);
			}
			deferred.resolve();
		} catch (error) {
			deferred.reject(error);
		} finally {
			yield connection.close();
		}
	});
	return deferred.promise;
}

function increaseCount(aPref, aCount) {
	let count = Services.prefs.getIntPref(PREF_BRANCH + aPref);
	Services.prefs.setIntPref(PREF_BRANCH + aPref, count + aCount);
}

function formatPlural(aCount, aKey="cookieCount") {
	let formats = strings.GetStringFromName(aKey);
	return getPlural(aCount, formats).replace("%S", aCount);
}
