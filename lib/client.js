// dsh-some-optimizations — browser half (static/global install)
// -----------------------------------------------------------------------------
// Served to the browser by the web client module loader (window.__ModuleLoader__)
// because package.json declares dsh.client { platform: "web" }. Registers three
// toggle rows in Settings → General ("settings.general.item" slot):
//   1. 模型钉死 (modelPin) — force every request onto the last UI-selected model
//   2. tool-call id 归一化 (normalizeCallIds)
//   3. 解除流式超时 (unboundedStreamTimeouts)
// Each row reads/writes the plugin's same-origin route /dsh-some-optimizations/
// config (the official settings wire API only serves apiproxy-allowlisted
// namespaces); every flip saves immediately.

window.__ModuleLoader__.load({ id: 'dsh-some-optimizations', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var React = require('react');

exports.name = 'dsh-some-optimizations';
exports.inject = ['slots'];

var CONFIG_URL = '/dsh-some-optimizations/config';

// ===== stylesheet (injected once, idempotent across HMR) =====
var STYLE_ID = 'dso-style';
var CSS = [
  '.dso-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
  '.dso-text{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dso-title{color:var(--dsw-alias-label-primary,#111);font-size:14px;line-height:22px}',
  '.dso-desc{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
  '.dso-control{display:flex;align-items:center;gap:10px;flex:none}',
  '.dso-switch{width:36px;height:20px;appearance:none;border-radius:999px;background:var(--dsw-alias-fill-l3,rgba(128,128,128,.35));position:relative;cursor:pointer;transition:background .15s;flex:none}',
  '.dso-switch:checked{background:var(--dsw-alias-brand-primary,#4f7cff)}',
  '.dso-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
  '.dso-switch:checked::after{left:18px}',
  '.dso-switch:disabled{opacity:.4;cursor:default}',
].join('\n');

function adoptStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  var el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function readConfig() {
  return fetch(CONFIG_URL, { method: 'GET' }).then(function (response) {
    if (!response.ok) throw new Error('config route unavailable');
    return response.json();
  });
}

function writePatch(patch) {
  return fetch(CONFIG_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: patch }),
  }).then(function (response) {
    if (!response.ok) throw new Error('write refused');
    return response.json();
  });
}

/**
 * One boolean switch row.
 * spec: { field, title, desc }
 */
function makeSwitchRow(spec) {
  return function SwitchRow() {
    var state = React.useState({ status: 'loading', value: false });
    var snapshot = state[0];
    var setSnapshot = state[1];

    React.useEffect(function () {
      adoptStyles();
      var cancelled = false;
      readConfig().then(function (section) {
        if (!cancelled) setSnapshot({ status: 'ready', value: Boolean(section[spec.field]) });
      }).catch(function () {
        if (!cancelled) setSnapshot({ status: 'unavailable', value: false });
      });
      return function () { cancelled = true; };
    }, []);

    if (snapshot.status === 'unavailable') return null;
    var disabled = snapshot.status !== 'ready';

    function toggle(event) {
      var next = Boolean(event.currentTarget.checked);
      setSnapshot({ status: 'saving', value: next });   // optimistic
      writePatch(Object.fromEntries([[spec.field, next]])).then(function (section) {
        setSnapshot({ status: 'ready', value: Boolean(section[spec.field]) });
      }).catch(function () {
        setSnapshot({ status: 'ready', value: !next }); // revert on failure
      });
    }

    return React.createElement('div', { className: 'dso-row' },
      React.createElement('div', { className: 'dso-text' },
        React.createElement('div', { className: 'dso-title' }, spec.title),
        React.createElement('div', { className: 'dso-desc' }, spec.desc)),
      React.createElement('div', { className: 'dso-control' },
        React.createElement('input', {
          type: 'checkbox',
          className: 'dso-switch',
          checked: snapshot.value,
          disabled: disabled,
          'aria-label': spec.title,
          onChange: toggle,
        })));
  };
}

var SPECS = [
  {
    field: 'modelPin',
    title: '模型钉死（model-pin）',
    desc: '设置里最后点选的模型强制生效于之后所有请求，无视任何中间层改写。点击模型后日志立即回执 selection saved。',
  },
  {
    field: 'normalizeCallIds',
    title: 'tool-call id 归一化',
    desc: '流内改写中转伪造的工具调用 id（如 Kimi 系 read:0），杜绝「历史加载失败」与会话中途不再显示。',
  },
  {
    field: 'unboundedStreamTimeouts',
    title: '解除流式空闲超时',
    desc: '中转长思考/预填充期间零字节转发会撞上 undici 300s 默认超时（Stream ended without finish_reason）；开启后彻底禁用该限制。',
  },
];

// ===== registration =====
exports.apply = function apply(ctx) {
  var slots = ctx.get('slots');
  if (slots === undefined) return;
  SPECS.forEach(function (spec, index) {
    slots.inject('settings.general.item', function () {
      return slots.register({
        name: 'settings.general.item',
        id: 'some-optimizations-' + spec.field,
        order: 40 + index,
        inject: function () { return {}; },
      }, makeSwitchRow(spec));
    });
  });
};

return module.exports; } });
