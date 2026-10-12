/** Мок Google Apps Script для автотестов и демо, без аккаунта и внешних запросов. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_PATH = path.join(__dirname, '..', 'Code.gs');

function createEnv(options = {}) {
  const code = fs.readFileSync(CODE_PATH, 'utf8');
  const sheets = [];
  const events = [];
  const fetchLog = [];
  const props = new Map(Object.entries(Object.assign({
    BOT_TOKEN: '123456:TEST-TOKEN',
    MODERATOR_CHAT_ID: '7114829971',
    WEBHOOK_SECRET: 'test-webhook-secret'
  }, options.properties)));
  const nonempty = v => v !== '' && v !== null && v !== undefined;
  const overlaps = (a, b) => a.row < b.row + b.numRows && b.row < a.row + a.numRows &&
    a.col < b.col + b.numCols && b.col < a.col + a.numCols;

  function makeRange(sheet, row, col, numRows = 1, numCols = 1) {
    if (row < 1 || col < 1 || row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
      throw new Error('Range exceeds sheet grid');
    }
    const bounds = { row, col, numRows, numCols };
    const api = {
      setValues(vals) {
        if (options.failDataWrites && row > 1) throw new Error('Simulated sheet write failure');
        if (vals.length !== numRows || vals.some(r => r.length !== numCols)) throw new Error('Range size mismatch');
        vals.forEach((r, i) => r.forEach((v, j) => {
          const ri = row + i, ci = col + j;
          sheet.validations.forEach(rule => {
            if (ri >= rule.row && ri < rule.row + rule.numRows && ci >= rule.col && ci < rule.col + rule.numCols &&
                rule.validation.allowInvalid === false && nonempty(v) && !rule.validation.values.includes(v)) {
              throw new Error('Data validation rejected ' + v);
            }
          });
          sheet.data[ri - 1] = sheet.data[ri - 1] || [];
          sheet.data[ri - 1][ci - 1] = v;
        }));
        events.push({ type: 'sheet-write', sheet: sheet.name, row });
        return api;
      },
      setValue(v) { return api.setValues([[v]]); },
      getValues() {
        return Array.from({ length: numRows }, (_, i) => Array.from({ length: numCols }, (_, j) => {
          const src = sheet.data[row - 1 + i] || [];
          return src[col - 1 + j] === undefined ? '' : src[col - 1 + j];
        }));
      },
      getDisplayValues() { return api.getValues().map(r => r.map(String)); },
      setNumberFormat(format) { sheet.formats.push({ ...bounds, format }); return api; },
      setFontWeight() { return api; }, setFontColor() { return api; }, setBackground() { return api; },
      setVerticalAlignment() { return api; }, setHorizontalAlignment() { return api; },
      setFontSize() { return api; }, setWrap() { return api; },
      setDataValidation(validation) { sheet.validations.push({ ...bounds, validation }); return api; },
      clearDataValidations() { sheet.validations = sheet.validations.filter(v => !overlaps(bounds, v)); return api; },
      clearContent() {
        for (let i = 0; i < numRows; i++) for (let j = 0; j < numCols; j++) {
          if (sheet.data[row - 1 + i]) sheet.data[row - 1 + i][col - 1 + j] = '';
        }
        return api;
      }
    };
    return api;
  }

  function makeSheet(name) {
    const sheet = {
      name, data: [], validations: [], formats: [], gid: 100 + sheets.length,
      maxRows: options.maxRows || 1000, maxCols: options.maxCols || 26, hiddenCols: [],
      getName: () => sheet.name, getSheetId: () => sheet.gid, getParent: () => ss,
      setName(n) { sheet.name = n; return sheet; },
      getLastRow: () => sheet.data.reduce((last, r, i) => r && r.some(nonempty) ? i + 1 : last, 0),
      getLastColumn: () => Math.max(0, ...sheet.data.map(r => r ? r.reduce((last, v, i) => nonempty(v) ? i + 1 : last, 0) : 0)),
      getMaxRows: () => sheet.maxRows, getMaxColumns: () => sheet.maxCols,
      insertRowsAfter(after, n) { sheet.maxRows += n; },
      insertColumnsAfter(after, n) { sheet.maxCols += n; },
      deleteRows(start, n = 1) { sheet.data.splice(start - 1, n); sheet.maxRows -= n; },
      setFrozenRows(n) { sheet.frozenRows = n; }, setRowHeight() {}, setColumnWidth() {}, setTabColor() {},
      hideColumns(start, n) {
        for (let i = 0; i < n; i++) if (!sheet.hiddenCols.includes(start + i)) sheet.hiddenCols.push(start + i);
        sheet.hiddenCols.sort((x, y) => x - y);
      },
      showColumns(start, n) { sheet.hiddenCols = sheet.hiddenCols.filter(c => c < start || c >= start + n); },
      copyTo(target) {
        if (options.failBackup) throw new Error('Simulated backup failure');
        const copy = makeSheet('Копия ' + sheet.name);
        copy.data = sheet.data.map(r => r.map(v => v instanceof Date ? new Date(v) : v));
        copy.maxRows = sheet.maxRows; copy.maxCols = sheet.maxCols;
        copy.hiddenCols = sheet.hiddenCols.slice();
        copy.validations = sheet.validations.slice(); copy.formats = sheet.formats.slice();
        target.sheets.push(copy);
        return copy;
      },
      getRange: (r, c, nr, nc) => makeRange(sheet, r, c, nr, nc)
    };
    return sheet;
  }

  const ss = {
    sheets, name: 'Подсолнух — брони', tz: 'UTC', url: 'https://docs.google.com/spreadsheets/d/TESTID/edit',
    getId: () => 'TESTID', getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = makeSheet(n); sheets.push(s); return s; },
    getName: () => ss.name, getUrl: () => ss.url,
    setSpreadsheetTimeZone: tz => { ss.tz = tz; }, getSpreadsheetTimeZone: () => ss.tz
  };

  function newValidation() {
    const rule = { values: [], allowInvalid: true };
    return {
      requireValueInList(values) { rule.values = values; return this; },
      setAllowInvalid(value) { rule.allowInvalid = value; return this; },
      build() { return rule; }
    };
  }

  const mocks = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss, newDataValidation: newValidation,
      flush() { events.push({ type: 'flush' }); }
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => props.has(k) ? props.get(k) : null,
      setProperty: (k, v) => props.set(k, String(v))
    }) },
    LockService: { getScriptLock: () => ({
      waitLock() { if (options.failLock) throw new Error('Simulated lock timeout'); events.push({ type: 'lock' }); },
      releaseLock() { events.push({ type: 'unlock' }); }
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      formatDate(date, tz, pattern) {
        const p = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
        return pattern.replace(/yyyy/g, p.year).replace(/dd/g, p.day).replace(/MM/g, p.month)
          .replace(/HH/g, p.hour === '24' ? '00' : p.hour).replace(/mm/g, p.minute).replace(/ss/g, p.second);
      }
    },
    UrlFetchApp: {
      fetch(url, opts) {
        const entry = { url, payload: (opts && opts.payload) || {} };
        fetchLog.push(entry); events.push({ type: 'telegram', url });
        if (options.telegramThrowsToken) throw new Error('Request failed for ' + url);
        const reply = obj => ({ getContentText: () => JSON.stringify(obj) });
        if (/getMe/.test(url)) return reply({ ok: true, result: { username: 'podsolnuh_bot', id: 1 } });
        if (/sendMessage/.test(url)) {
          if (options.telegramThrows) throw new Error('Simulated Telegram network failure');
          return options.telegramSendOk === false
            ? reply({ ok: false, description: 'Forbidden: bot was blocked by the user' })
            : reply({ ok: true, result: { message_id: 100 + fetchLog.length } });
        }
        if (/answerCallbackQuery|editMessageText|deleteWebhook/.test(url)) return reply({ ok: true, result: true });
        if (/setWebhook/.test(url)) return reply({ ok: true, result: true, description: 'Webhook was set' });
        return reply({ ok: false, description: 'unexpected method' });
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: txt => ({ setMimeType() { return this; }, getContent: () => txt })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TESTDEPLOY/exec' }) },
    Logger: { log: m => options.verbose && console.log('[Logger] ' + m) },
    console: options.verbose ? console : { error() {} }
  };

  const factory = new Function(...Object.keys(mocks), code + `
    return { setup, setupTelegram, removeTelegramWebhook, testConnection, doGet, doPost,
      computeStatuses_, parseDates_, headers: HEADERS, columns: COL, visibleCount: VISIBLE_COUNT };
  `);
  const api = factory(...Object.values(mocks));
  return { api, ss, sheet: () => ss.getSheetByName('Брони'), fetchLog, props, events };
}

module.exports = { createEnv };
