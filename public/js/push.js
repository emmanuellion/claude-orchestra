/**
 * Browser side of Web Push: register the worker, subscribe, tell the server.
 *
 * This is what makes remote approval real. The Notification API that
 * notifications.js drives only fires while the page is alive, which on a phone
 * means "while you are already looking at it". A push subscription is the only
 * thing that reaches a locked screen.
 *
 * Push is strictly additive: nothing here replaces the in-page notifications,
 * which stay better when you *are* at the desk. This layer only covers the case
 * the other one structurally cannot.
 */

const SW_URL = '/sw.js';

/** Raw P-256 point, which is what `applicationServerKey` wants as bytes. */
function b64urlToBytes(base64url) {
  const base64 = String(base64url).replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A label so the settings list says "iPhone" rather than an opaque endpoint. */
function deviceLabel(nav) {
  const ua = (nav && nav.userAgent) || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'This device';
}

export class PushClient {
  /**
   * @param {{request: Function}} api  `request(method, path, body)`
   * @param {{window?: Window, logger?: object}} [deps]
   */
  constructor(api, deps = {}) {
    this.api = api;
    this.win = deps.window || (typeof window !== 'undefined' ? window : null);
    this.log = deps.logger || console;
    this.nav = this.win ? this.win.navigator : null;
    this.registration = null;
    /** Set when something refuses, so the settings pane can say what. */
    this.lastError = null;
  }

  /**
   * Why push cannot work here, or null when it can.
   *
   * The secure-context check is the one that actually bites: reaching Orchestra
   * from a phone over plain http on a LAN address gives no service worker at
   * all, and the failure is otherwise silent.
   */
  unsupportedReason() {
    if (!this.win || !this.nav) return 'no browser context';
    if (!('serviceWorker' in this.nav)) return 'this browser has no service workers';
    if (!this.win.isSecureContext) {
      return 'push needs a secure context: reach Orchestra over https (a tunnel) or on localhost';
    }
    // Checked before the generic Push API test, because on iOS that test fails
    // for one specific and fixable reason, and "this browser has no Push API"
    // would send someone looking for another browser instead of tapping Share.
    if (this._isIOS() && !this._isStandalone()) {
      return 'on iPhone and iPad, push only works once this page is added to the home screen:'
        + ' tap Share, then "Add to Home Screen", and open Orchestra from that icon';
    }
    if (!('PushManager' in this.win)) return 'this browser has no Push API';
    if (!('Notification' in this.win)) return 'this browser has no notifications';
    return null;
  }

  _isIOS() {
    const ua = (this.nav && this.nav.userAgent) || '';
    // iPadOS reports itself as a Mac, so the touch point count is what
    // separates an iPad from a desktop Safari that does support push.
    return /iPhone|iPad|iPod/i.test(ua)
      || (/Macintosh/i.test(ua) && (this.nav.maxTouchPoints || 0) > 1);
  }

  _isStandalone() {
    if (this.nav && this.nav.standalone) return true;
    return !!(this.win.matchMedia && this.win.matchMedia('(display-mode: standalone)').matches);
  }

  get supported() {
    return this.unsupportedReason() === null;
  }

  /** Registers the worker. Safe to call repeatedly. */
  async register() {
    const why = this.unsupportedReason();
    if (why) {
      this.lastError = why;
      return null;
    }
    if (this.registration) return this.registration;
    try {
      this.registration = await this.nav.serviceWorker.register(SW_URL);
      return this.registration;
    } catch (err) {
      this.lastError = `could not register the service worker: ${err.message}`;
      this.log.warn(`[push] ${this.lastError}`);
      return null;
    }
  }

  /** The active subscription for this browser, or null. */
  async current() {
    const reg = await this.register();
    if (!reg) return null;
    try {
      return await reg.pushManager.getSubscription();
    } catch (err) {
      this.lastError = err.message;
      return null;
    }
  }

  async isSubscribed() {
    return !!(await this.current());
  }

  /**
   * Asks for permission, subscribes, and registers the subscription server
   * side. Returns a reason string on failure rather than throwing, because
   * every caller is a click handler that has to render the reason.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async subscribe() {
    this.lastError = null;
    const why = this.unsupportedReason();
    if (why) return { ok: false, error: why };

    const permission = await this.win.Notification.requestPermission();
    if (permission !== 'granted') {
      return { ok: false, error: `notification permission is "${permission}"` };
    }

    const reg = await this.register();
    if (!reg) return { ok: false, error: this.lastError || 'no service worker' };

    let key;
    try {
      const info = await this.api.request('GET', '/api/push/key');
      key = info && info.publicKey;
    } catch (err) {
      return { ok: false, error: `could not read the server key: ${err.message}` };
    }
    if (!key) return { ok: false, error: 'the server returned no push key' };

    let subscription;
    try {
      // An existing subscription made against a different server key is dead
      // weight: it can never be decrypted by this server, so it is replaced.
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        const same = bytesToB64url(existing.options.applicationServerKey || new ArrayBuffer(0)) === key;
        if (!same) await existing.unsubscribe();
        else subscription = existing;
      }
      if (!subscription) {
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64urlToBytes(key),
        });
      }
    } catch (err) {
      return { ok: false, error: `the browser refused the subscription: ${err.message}` };
    }

    try {
      await this.api.request('POST', '/api/push/subscribe', {
        subscription: subscription.toJSON(),
        label: deviceLabel(this.nav),
      });
    } catch (err) {
      return { ok: false, error: `the server rejected the subscription: ${err.message}` };
    }
    return { ok: true };
  }

  /** Unsubscribes here and forgets it there. */
  async unsubscribe() {
    const subscription = await this.current();
    if (!subscription) return { ok: true };
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
    } catch (err) {
      this.log.warn(`[push] browser unsubscribe failed: ${err.message}`);
    }
    try {
      await this.api.request('POST', '/api/push/unsubscribe', { endpoint });
    } catch (err) {
      return { ok: false, error: err.message };
    }
    return { ok: true };
  }

  async sendTest() {
    try {
      const out = await this.api.request('POST', '/api/push/test');
      if (!out || !out.sent) {
        return { ok: false, error: 'the server had nothing to deliver to; subscribe first' };
      }
      return { ok: true, sent: out.sent };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Routes a tap on a notification once the tab is focused. The worker cannot
   * navigate the app itself, so it posts here and the app decides.
   *
   * @param {(view: string, sessionId: string|null) => void} navigate
   */
  listen(navigate) {
    if (!this.nav || !('serviceWorker' in this.nav)) return () => {};
    const handler = (event) => {
      const data = event.data;
      if (!data || data.source !== 'orchestra-push') return;
      let view = 'terminals';
      try {
        const url = new URL(data.url, this.win.location.origin);
        view = url.searchParams.get('view') || view;
      } catch { /* a malformed url just means the default view */ }
      navigate(view, data.sessionId || null);
    };
    this.nav.serviceWorker.addEventListener('message', handler);
    return () => this.nav.serviceWorker.removeEventListener('message', handler);
  }
}

export default PushClient;
