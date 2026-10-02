'use strict';

// Plugin settings in <userData>/settings.json. The password is encrypted with Electron's
// safeStorage (Keychain on macOS, DPAPI on Windows) and never sent to the renderer.

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  baseUrl: '',
  username: '',
  rememberPassword: true,
  passwordEnc: null,
  // Per-machine path rewrites applied to Portal's paths: [{ from, to }]
  rewrites: [],
  descriptionField: '',
  skipExisting: true,
  writeMetadata: true,
  view: 'grid',
};

const EDITABLE = ['baseUrl', 'rewrites', 'descriptionField', 'skipExisting', 'writeMetadata', 'view'];

class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    this.sessionPassword = null;
    this.data = { ...DEFAULTS };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // first run or unreadable file: defaults
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // What the renderer may see.
  public() {
    const { passwordEnc, ...rest } = this.data;
    return rest;
  }

  update(partial) {
    for (const key of EDITABLE) if (key in partial) this.data[key] = partial[key];
    this.save();
    return this.public();
  }

  canEncrypt() {
    return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
  }

  setCredentials({ baseUrl, username, password, remember }) {
    this.data.baseUrl = baseUrl;
    this.data.username = username;
    this.sessionPassword = password;
    this.data.rememberPassword = !!remember;
    this.data.passwordEnc = remember && this.canEncrypt() ? this.safeStorage.encryptString(password).toString('base64') : null;
    this.save();
  }

  getPassword() {
    if (this.sessionPassword) return this.sessionPassword;
    if (this.data.passwordEnc && this.canEncrypt()) {
      try {
        this.sessionPassword = this.safeStorage.decryptString(Buffer.from(this.data.passwordEnc, 'base64'));
      } catch {
        this.data.passwordEnc = null;
      }
    }
    return this.sessionPassword;
  }

  clearCredentials() {
    this.sessionPassword = null;
    this.data.passwordEnc = null;
    this.save();
  }
}

module.exports = { Settings, DEFAULTS };
