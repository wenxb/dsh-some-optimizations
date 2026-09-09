// dsh-some-optimizations — browser half (static/global install)
// -----------------------------------------------------------------------------
// Served to the browser by the web client module loader (window.__ModuleLoader__)
// because package.json declares dsh.client { platform: "web" }. Registers a
// collapsible card in Settings → Plugins ("settings.plugin.item" slot):
//   1. tool-call id 归一化 (normalizeCallIds)
//   2. 解除流式超时 (unboundedStreamTimeouts)
//   3. 投影缓存孤儿行回收 (projCacheGc)
//   4. 滚动清图 (imageShed)
// Reads/writes the plugin's same-origin route /dsh-some-optimizations/config;
// every toggle saves immediately.

window.__ModuleLoader__.load({ id: 'dsh-some-optimizations', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var React = require('react');

exports.name = 'dsh-some-optimizations';
exports.inject = ['slots'];

var CONFIG_URL = '/dsh-some-optimizations/config';

// ===== stylesheet (injected once, idempotent across HMR) =====
var STYLE_ID = 'dso-style';
var CSS = [
  '.dso-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-3,rgba(255,255,255,.03));border-radius:12px;list-style:none;transition:border-color .16s,background .16s;margin-bottom:12px}',
  '.dso-card:hover{border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.4))}',
  '.dso-cardOpen{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.05));border-color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.4))}',
  '.dso-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  '.dso-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f7cff);outline-offset:-2px}',
  '.dso-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
  '.dso-name{color:var(--dsw-alias-label-primary,#111);font-size:15px;font-weight:600;line-height:1.4}',
  '.dso-description{color:var(--dsw-alias-label-tertiary,#888);font-size:13px;line-height:1.5}',
  '.dso-chevron{color:var(--dsw-alias-label-tertiary,#888);flex:none;transition:transform .16s;width:16px;height:16px}',
  '.dso-chevronOpen{transform:rotate(180deg)}',
  '.dso-body{border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));margin:0 16px;padding:4px 0 12px}',
  '.dso-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.15))}',
  '.dso-row:last-child{border-bottom:0}',
  '.dso-text{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dso-title{color:var(--dsw-alias-label-primary,#111);font-size:14px;line-height:20px;font-weight:500}',
  '.dso-desc{color:var(--dsw-alias-label-tertiary,#888);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
  '.dso-control{display:flex;align-items:center;gap:10px;flex:none}',
  '.dso-switch{width:36px;height:20px;appearance:none;border-radius:999px;background:var(--dsw-alias-fill-l3,rgba(128,128,128,.35));position:relative;cursor:pointer;transition:background .15s;flex:none;margin:0}',
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

var SPECS = [
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
  {
    field: 'projCacheGc',
    title: '投影缓存孤儿行回收',
    desc: '定期删除投影缓存（session_projcache）里已无对应持久化日志的检查点行；官方无淘汰接口，孤儿行会让缓存无限膨胀、全量重写拖垮磁盘。',
  },
  {
    field: 'imageShed',
    title: '滚动清图（image-shed）',
    desc: '表面上只保留最新 2 张图片（张数可调 imageShedKeepLatest），更老的立即替换为带名称/尺寸/哈希线索的文本占位符，文本内容原样保留。不依赖压缩节奏——历史截图无限累积撑爆请求体（NIM 约 7-8MiB 就拒收）的根因治理。',
  },
];

/**
 * Collapsible card for Settings → Plugins tab.
 */
function SomeOptimizationsCard() {
  var openState = React.useState(false);
  var open = openState[0];
  var setOpen = openState[1];

  var configState = React.useState({ status: 'loading', value: {} });
  var config = configState[0];
  var setConfig = configState[1];

  React.useEffect(function () {
    adoptStyles();
    var cancelled = false;
    readConfig().then(function (section) {
      if (!cancelled) setConfig({ status: 'ready', value: section });
    }).catch(function () {
      if (!cancelled) setConfig({ status: 'unavailable', value: {} });
    });
    return function () { cancelled = true; };
  }, []);

  function toggle(field, next) {
    var prev = Boolean(config.value[field]);
    setConfig(function (current) {
      var nextValue = Object.assign({}, current.value);
      nextValue[field] = next;
      return { status: 'ready', value: nextValue };
    });
    var patch = {};
    patch[field] = next;
    writePatch(patch).then(function (section) {
      setConfig({ status: 'ready', value: section });
    }).catch(function () {
      setConfig(function (current) {
        var reverted = Object.assign({}, current.value);
        reverted[field] = prev;
        return { status: 'ready', value: reverted };
      });
    });
  }

  var cardClass = 'dso-card' + (open ? ' dso-cardOpen' : '');
  var chevronClass = 'dso-chevron' + (open ? ' dso-chevronOpen' : '');
  var disabled = config.status !== 'ready';

  return React.createElement('li', { className: cardClass },
    React.createElement('button', {
      type: 'button',
      className: 'dso-header',
      'aria-expanded': open,
      'aria-label': (open ? '收起' : '展开') + '：DSH 优化',
      onClick: function () { setOpen(!open); },
    },
      React.createElement('div', { className: 'dso-headText' },
        React.createElement('span', { className: 'dso-name' }, 'DSH 优化'),
        React.createElement('span', { className: 'dso-description' }, '个人 LLM 链路优化开关集')
      ),
      React.createElement('svg', {
        className: chevronClass,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '2',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        React.createElement('path', { d: 'M4 6l4 4 4-4' })
      )
    ),
    open ? React.createElement('div', { className: 'dso-body' },
      SPECS.map(function (spec) {
        return React.createElement('div', { key: spec.field, className: 'dso-row' },
          React.createElement('div', { className: 'dso-text' },
            React.createElement('div', { className: 'dso-title' }, spec.title),
            React.createElement('div', { className: 'dso-desc' }, spec.desc)
          ),
          React.createElement('div', { className: 'dso-control' },
            React.createElement('input', {
              type: 'checkbox',
              className: 'dso-switch',
              checked: Boolean(config.value[spec.field]),
              disabled: disabled,
              'aria-label': spec.title,
              onChange: function (e) { toggle(spec.field, Boolean(e.target.checked)); },
            })
          )
        );
      })
    ) : null
  );
}

// ===== registration =====
exports.apply = function apply(ctx) {
  var slots = ctx.get('slots');
  if (slots === undefined) return;
  slots.inject('settings.plugin.item', function () {
    return slots.register({
      name: 'settings.plugin.item',
      key: 'some-optimizations',
      inject: function () { return {}; },
    }, SomeOptimizationsCard);
  });
};

return module.exports; } });
