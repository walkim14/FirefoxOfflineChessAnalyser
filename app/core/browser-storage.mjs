export function storageGet(key) {
	return new Promise((resolve, reject) => {
		try {
			const maybePromise = chrome.storage.local.get(key, (value) => {
				const err = chrome.runtime?.lastError;
				if (err) {
					reject(new Error(err.message));
					return;
				}
				resolve(value || {});
			});

			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve).catch(reject);
			}
		} catch (error) {
			reject(error);
		}
	});
}

export function storageSet(value) {
	return new Promise((resolve, reject) => {
		try {
			const maybePromise = chrome.storage.local.set(value, () => {
				const err = chrome.runtime?.lastError;
				if (err) {
					reject(new Error(err.message));
					return;
				}
				resolve();
			});

			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise.then(resolve).catch(reject);
			}
		} catch (error) {
			reject(error);
		}
	});
}
