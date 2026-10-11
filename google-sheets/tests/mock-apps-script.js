/**
 * Мок-окружение Google Apps Script для локальной проверки google-sheets/Code.gs
 * без Google-аккаунта: подменяет SpreadsheetApp, UrlFetchApp, PropertiesService и т.д.
 *
 * Используется в google-sheets/tests/backend.test.js и demo/serve.js.
 */
const fs = require('fs');
const path = require('path');

const CODE_PATH = path.join(__dirname, '..', 'Code.gs');

function createEnv(options) {
  options = options || {};
  const code = fs.readFileSync(CODE_PATH, 'utf8')
    .replace('ВСТАВЬТЕ_ТОКЕН_БОТА', options.botToken || '123456:TEST-TOKEN');

  /* ------------------------------ Google Sheets ------------------------------ */
  const sheets = [];
  function makeRange(sheet, row, col, numRows, numCols) {
    const api = {
      setValues(vals) {
        vals.forEach((r, i) => {
          const ri = row - 1 + i;
          sheet.data[ri] = sheet.data[ri] || [];
          r.forEach((v, j) => { sheet.data[ri][col - 1 + j] = v; });
        });
        return api;
      },
      setValue(v) { sheet.data[row - 1] = sheet.data[row - 1] || []; sheet.data[row - 1][col - 1] = v; return api; },
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const src = sheet.data[row - 1 + i] || [];
          const line = [];
          for (let j = 0; j < numCols; j++) line.push(src[col - 1 + j] === undefined ? '' : src[col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      getDisplayValues() { return api.getValues().map(r => r.map(String)); },
      setNumberFormat() { return api; }, setFontWeight() { return api; }, setFontColor() { return api; },
      setBackground() { return api; }, setVerticalAlignment() { return api; },
      setHorizontalAlignment() { return api; }, setFontSize() { return api; },
      setDataValidation(v) { sheet.validations.push(v); return api; }, setWrap() { return api; }
    };
    return api;
  }
  function makeSheet(name) {
    const sheet = {
      name, data: [], validations: [], gid: 100 + sheets.length,
      getName: () => name, getSheetId: () => sheet.gid, getLastRow: () => sheet.data.length,
      setFrozenRows() {}, setRowHeight() {}, setColumnWidth() {}, setTabColor() {},
      getRange: (r, c, nr, nc) => makeRange(sheet, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc)
    };
    return sheet;
  }
  const ss = {
    sheets, name: 'Подсолнух — брони', tz: 'UTC',
    url: 'https://docs.google.com/spreadsheets/d/TESTID/edit',
    getSheetByName: n => sheets.find(s => s.name === n) || null,
    insertSheet: n => { const s = makeSheet(n); sheets.push(s); return s; },
    getName: () => ss.name, getUrl: () => ss.url,
    setSpreadsheetTimeZone: tz => { ss.tz = tz; }, getSpreadsheetTimeZone: () => ss.tz
  };

  /* ------------------------------ остальные сервисы ------------------------------ */
  const props = new Map();
  const fetchLog = [];              // все обращения к Telegram API
  const chain = () => ({ requireValueInList: chain, setAllowInvalid: chain, build: () => ({}) });

  const mocks = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss, newDataValidation: chain },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v)
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      formatDate(date, tz, pattern) {
        const p = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
        return pattern
          .replace(/yyyy/g, p.year).replace(/dd/g, p.day).replace(/MM/g, p.month)
          .replace(/HH/g, p.hour === '24' ? '00' : p.hour).replace(/mm/g, p.minute);
      }
    },
    UrlFetchApp: {
      fetch(url, opts) {
        fetchLog.push({ url, payload: (opts && opts.payload) || {} });
        const reply = obj => ({ getContentText: () => JSON.stringify(obj) });
        if (/getMe/.test(url)) return reply({ ok: true, result: { username: 'podsolnuh_bot', id: 1 } });
        if (/sendMessage/.test(url)) return reply({ ok: true, result: { message_id: 100 + fetchLog.length } });
        if (/answerCallbackQuery|editMessageText/.test(url)) return reply({ ok: true, result: true });
        if (/setWebhook/.test(url)) return reply({ ok: true, result: true, description: 'Webhook was set' });
        return reply({ ok: false, description: 'unexpected ' + url });
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: txt => ({ txt, setMimeType() { return this; }, getContent() { return txt; } })
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TESTDEPLOY/exec' }) },
    Logger: { log: m => (options.verbose && console.log('[Logger] ' + m)) },
    console
  };

  const factory = new Function(...Object.keys(mocks), code + `
    return { setup, setupTelegram, removeTelegramWebhook, testConnection, doGet, doPost, computeStatuses_, parseDates_ };
  `);
  const api = factory(...Object.values(mocks));
  return { api, ss, sheet: () => ss.getSheetByName('Брони'), fetchLog, props };
}

module.exports = { createEnv };
