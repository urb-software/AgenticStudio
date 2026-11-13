/* @ds-bundle: {"format":4,"namespace":"AgentStudio","components":[{"name":"Button"},{"name":"IconButton"},{"name":"Icon"},{"name":"StatusPill"},{"name":"StatusDot"},{"name":"Badge"},{"name":"Chip"},{"name":"Kbd"},{"name":"TextField"},{"name":"Switch"},{"name":"SegmentedControl"},{"name":"Tabs"},{"name":"Card"},{"name":"Banner"},{"name":"Toast"},{"name":"EmptyState"},{"name":"Dialog"},{"name":"NavItem"},{"name":"RunTimeline"},{"name":"LogViewer"},{"name":"DiffView"},{"name":"Skeleton"}]} */
(function () {
  var R = window.React, h = R.createElement, useState = R.useState;
  function cx() { return Array.prototype.filter.call(arguments, Boolean).join(' '); }
  function omit(o, keys) { var r = {}; for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k) && keys.indexOf(k) < 0) r[k] = o[k]; } return r; }

  var ICONS = {
    plus: 'M12 5v14 M5 12h14', x: 'M18 6L6 18 M6 6l12 12', check: 'M20 6L9 17l-5-5',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M21 21l-4.3-4.3',
    play: 'M6 4l14 8-14 8z', stop: 'M6 6h12v12H6z',
    refresh: 'M3 12a9 9 0 0 1 15-6.7L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15 6.7L3 16 M3 21v-5h5',
    alert: 'M12 9v4 M12 17h.01 M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    info: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M12 16v-4 M12 8h.01',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
    merge: 'M18 21a3 3 0 1 0 0-6a3 3 0 1 0 0 6z M6 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6z M6 21V9 M6 9a9 9 0 0 0 9 9',
    branch: 'M6 3v12 M18 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M18 9a9 9 0 0 1-9 9',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    bot: 'M12 8V4H8 M5 8h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z M2 14h2 M20 14h2 M9 13v2 M15 13v2',
    sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 17v4 M17 19h4',
    workflow: 'M3 3h7v7H3z M14 14h7v7h-7z M6.5 10v3.5a3 3 0 0 0 3 3H14',
    activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
    server: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
    sliders: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
    bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.94 1.94 0 0 0 3.4 0',
    sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4',
    moon: 'M12 3a6 6 0 0 0 9 9a9 9 0 1 1-9-9z',
    terminal: 'M4 17l6-6-6-6 M12 19h8', diff: 'M12 3v14 M5 10h14 M5 21h14',
    flask: 'M9 3h6 M10 3v6L4 20a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 20L14 9V3',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
    lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
    ext: 'M15 3h6v6 M10 14L21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    chevR: 'M9 18l6-6-6-6', chevD: 'M6 9l6 6 6-6', down: 'M12 5v14 M19 12l-7 7-7-7',
    msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    globe: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z M2 12h20 M12 2a15 15 0 0 1 0 20 M12 2a15 15 0 0 0 0 20',
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z',
    list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
    monitor: 'M2 3h20v14H2z M8 21h8 M12 17v4', tablet: 'M5 2h14v20H5z M12 18h.01', phone: 'M7 2h10v20H7z M12 18h.01',
    logo: 'M12 3l7 4v10l-7 4-7-4V7z M12 8v8 M8.5 10l7 4 M15.5 10l-7 4'
  };

  function Icon(p) {
    return h('svg', { className: cx('as-ic', p.size === 'sm' && 'as-ic-sm', p.size === 'lg' && 'as-ic-lg', p.className), viewBox: '0 0 24 24', 'aria-hidden': 'true' }, h('path', { d: ICONS[p.name] || p.d || '' }));
  }
  Icon.paths = ICONS;

  function Button(p) {
    var variant = p.variant || 'secondary', size = p.size || 'md';
    var rest = omit(p, ['variant', 'size', 'loading', 'icon', 'iconRight', 'className', 'children', 'as']);
    var kids = [p.loading ? h('span', { key: 's', className: 'as-spinner' }) : (p.icon ? h(Icon, { key: 'i', name: p.icon, size: size === 'sm' ? 'sm' : undefined }) : null), p.children, p.iconRight ? h(Icon, { key: 'r', name: p.iconRight, size: 'sm' }) : null];
    var cls = cx('as-btn', variant !== 'secondary' && 'as-btn-' + variant, size !== 'md' && 'as-btn-' + size, p.className);
    if (p.as === 'a') return h.apply(null, ['a', Object.assign({ className: cls }, rest)].concat(kids));
    return h.apply(null, ['button', Object.assign({ type: 'button', className: cls, disabled: p.disabled || p.loading, 'aria-busy': p.loading ? 'true' : undefined }, rest)].concat(kids));
  }

  function IconButton(p) {
    var rest = omit(p, ['icon', 'label', 'size', 'dot', 'className']);
    return h('button', Object.assign({ type: 'button', className: cx('as-icbtn', p.size === 'sm' && 'as-icbtn-sm', p.className), 'aria-label': p.label, title: p.label }, rest),
      h(Icon, { name: p.icon }), p.dot ? h('span', { className: 'as-icbtn-dot' }) : null);
  }

  var STATUS_LABEL = { queued: 'Queued', running: 'Running', awaiting: 'Awaiting approval', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', none: 'No runs yet' };
  function StatusPill(p) { var s = p.status || 'queued'; return h('span', { className: cx('as-pill', 'as-pill-' + s, p.className) }, p.children || STATUS_LABEL[s]); }

  var DOT = { healthy: 'green', building: 'blue', starting: 'blue', awaiting: 'amber', unhealthy: 'red', stopped: 'muted' };
  function StatusDot(p) {
    var dot = h('span', { className: cx('as-dot', 'as-dot-' + (DOT[p.health] || 'muted')), title: p.children ? undefined : p.health });
    return p.children ? h('span', { className: 'as-dotlabel' }, dot, p.children) : dot;
  }

  var BADGE_LABEL = { claude: 'Claude Code', codex: 'Codex' };
  function Badge(p) { var v = p.variant || 'neutral'; return h('span', { className: cx('as-badge', v !== 'neutral' && 'as-badge-' + v, p.className) }, p.children || BADGE_LABEL[v] || ''); }
  function Chip(p) { return h('span', { className: cx('as-chip', p.mono && 'as-chip-mono', p.className) }, p.icon ? h(Icon, { name: p.icon, size: 'sm' }) : null, p.children); }
  function Kbd(p) { return h('kbd', { className: 'as-kbd' }, p.children); }

  var fid = 0;
  function TextField(p) {
    var idRef = R.useRef(p.id || 'as-f-' + (++fid)); var id = idRef.current;
    var rest = omit(p, ['label', 'help', 'error', 'mono', 'multiline', 'id', 'className']);
    var inputProps = Object.assign({ id: id, className: cx('as-input', p.mono && 'as-input-mono', p.error && 'as-input-err', p.multiline && 'as-textarea'), 'aria-invalid': p.error ? 'true' : undefined, 'aria-describedby': (p.error || p.help) ? id + '-d' : undefined }, rest);
    return h('div', { className: cx('as-field', p.className) },
      p.label ? h('label', { className: 'as-label', htmlFor: id }, p.label) : null,
      h(p.multiline ? 'textarea' : 'input', inputProps),
      p.error ? h('p', { className: 'as-err', id: id + '-d', role: 'alert' }, h(Icon, { name: 'alert', size: 'sm' }), p.error)
        : (p.help ? h('p', { className: 'as-help', id: id + '-d' }, p.help) : null));
  }

  function useControlled(value, initial, onChange) {
    var st = useState(initial); var controlled = value !== undefined;
    return [controlled ? value : st[0], function (v) { if (!controlled) st[1](v); if (onChange) onChange(v); }];
  }

  function Switch(p) {
    var c = useControlled(p.checked, !!p.defaultChecked, p.onChange);
    return h('button', { type: 'button', role: 'switch', 'aria-checked': c[0] ? 'true' : 'false', className: cx('as-switch', c[0] && 'as-switch-on', p.className), onClick: function () { c[1](!c[0]); }, disabled: p.disabled },
      h('span', { className: 'as-switch-track' }), p.label ? h('span', null, p.label) : null);
  }

  function SegmentedControl(p) {
    var opts = p.options || []; var c = useControlled(p.value, p.defaultValue !== undefined ? p.defaultValue : (opts[0] && opts[0].value), p.onChange);
    return h('div', { className: cx('as-seg', p.className), role: 'group', 'aria-label': p.label },
      opts.map(function (o) {
        var on = o.value === c[0];
        return h('button', { key: o.value, type: 'button', className: cx('as-seg-b', on && 'as-seg-b-on'), 'aria-pressed': on ? 'true' : 'false', 'aria-label': o.icon && !o.label ? o.ariaLabel : undefined, onClick: function () { c[1](o.value); } },
          o.icon ? h(Icon, { name: o.icon, size: 'sm' }) : null, o.label || null);
      }));
  }

  function Tabs(p) {
    var items = p.items || []; var c = useControlled(p.value, p.defaultValue !== undefined ? p.defaultValue : (items[0] && items[0].value), p.onChange);
    return h('div', { className: cx('as-tabs', p.className), role: 'tablist', 'aria-label': p.label },
      items.map(function (t) {
        var on = t.value === c[0];
        return h('button', { key: t.value, type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false', className: cx('as-tab', on && 'as-tab-on'), onClick: function () { c[1](t.value); } },
          t.icon ? h(Icon, { name: t.icon, size: 'sm' }) : null, t.label,
          t.count !== undefined && t.count !== null ? h('span', { className: cx('as-count', t.attention && 'as-count-amber') }, t.count) : null);
      }));
  }

  function Card(p) {
    return h('section', { className: cx('as-card', p.className) },
      (p.title || p.actions) ? h('div', { className: 'as-card-h' }, p.title ? h('h2', { className: 'as-card-t' }, p.title) : h('span'), p.actions || null) : null,
      p.flush ? p.children : h('div', { className: 'as-card-b' }, p.children));
  }

  var TONE_ICON = { info: 'info', warning: 'alert', danger: 'alert', success: 'check' };
  function Banner(p) {
    var tone = p.tone || 'info';
    return h('div', { className: cx('as-banner', 'as-banner-' + tone, p.className), role: tone === 'danger' ? 'alert' : 'status' },
      h(Icon, { name: p.icon || TONE_ICON[tone] }), h('span', { style: { flex: '1 1 auto' } }, p.title ? h('b', null, p.title, ' ') : null, p.children), p.action || null);
  }

  function Toast(p) {
    var tone = p.tone || 'success';
    return h('div', { className: cx('as-toast', 'as-toast-' + tone, p.className), role: 'status' },
      h('span', { className: 'as-toast-ic' }, h(Icon, { name: p.icon || TONE_ICON[tone] })),
      h('span', { style: { flex: '1 1 auto', minWidth: 0 } }, h('span', { className: 'as-toast-t' }, p.title), p.description ? h('span', { className: 'as-toast-d' }, p.description) : null),
      p.onDismiss ? h(IconButton, { icon: 'x', label: 'Dismiss', size: 'sm', onClick: p.onDismiss, style: { margin: '-4px -6px 0 0' } }) : null);
  }

  function EmptyState(p) {
    return h('div', { className: cx('as-empty', p.tone === 'error' && 'as-empty-error', p.className), role: p.tone === 'error' ? 'alert' : undefined },
      p.illustration || (p.icon ? h('span', { className: 'as-empty-ic' }, h(Icon, { name: p.icon, size: 'lg' })) : null),
      h('h2', null, p.title), p.description ? h('p', null, p.description) : null, p.action || null);
  }

  function Dialog(p) {
    var titleId = R.useRef('as-dt-' + (++fid)).current;
    if (p.open === false) return null;
    var box = h('div', { className: cx('as-dialog', p.className), role: p.destructive ? 'alertdialog' : 'dialog', 'aria-modal': p.inline ? undefined : 'true', 'aria-labelledby': titleId, onClick: function (e) { e.stopPropagation(); }, style: p.width ? { maxWidth: p.width } : undefined },
      h('div', { className: 'as-dialog-h' }, h('h2', { className: 'as-dialog-t', id: titleId }, p.title), p.description ? h('p', { className: 'as-dialog-d' }, p.description) : null),
      p.children ? h('div', { className: 'as-dialog-b' }, p.children) : h('div', { style: { height: 16 } }),
      p.footer ? h('div', { className: 'as-dialog-f' }, p.footer) : null);
    if (p.inline) return box;
    return h('div', { className: 'as-overlay', onClick: p.onClose, onKeyDown: function (e) { if (e.key === 'Escape' && p.onClose) p.onClose(); } }, box);
  }

  function NavItem(p) {
    var rest = omit(p, ['icon', 'label', 'active', 'badge', 'collapsed', 'className']);
    return h('button', Object.assign({ type: 'button', className: cx('as-nav', p.active && 'as-nav-on', p.className), 'aria-current': p.active ? 'page' : undefined, title: p.collapsed ? p.label : undefined, 'aria-label': p.collapsed ? p.label : undefined }, rest),
      h(Icon, { name: p.icon }), p.collapsed ? null : h('span', null, p.label), p.badge && !p.collapsed ? h('span', { className: 'as-nav-badge' }, p.badge) : null);
  }

  var DEFAULT_STEPS = ['Queued', 'Preparing worktree', 'Running CLI', 'Tests', 'Awaiting approval', 'Merged'];
  function RunTimeline(p) {
    var steps = p.steps || DEFAULT_STEPS.map(function (l) { return { label: l }; });
    var cur = p.current !== undefined ? p.current : 0; var st = p.state || 'running';
    var out = [];
    steps.forEach(function (s, i) {
      var label = typeof s === 'string' ? s : s.label; var k;
      if (st === 'succeeded') k = 'done';
      else if (i < cur) k = 'done';
      else if (i > cur) k = 'todo';
      else k = st === 'failed' ? 'failed' : (st === 'awaiting' ? 'gate' : 'current');
      var node = k === 'done' ? h(Icon, { name: 'check', size: 'sm' }) : k === 'failed' ? h(Icon, { name: 'x', size: 'sm' }) : (k === 'current' || k === 'gate') ? h('span', { className: 'as-tl-pulse' }) : String(i + 1);
      out.push(h('div', { key: 's' + i, className: cx('as-tl-step', k !== 'todo' && 'as-tl-' + k), 'aria-current': (k === 'current' || k === 'gate') ? 'step' : undefined }, h('span', { className: 'as-tl-node' }, node), h('span', null, label)));
      if (i < steps.length - 1) out.push(h('span', { key: 'b' + i, className: cx('as-tl-bar', k === 'done' && 'as-tl-bar-done') }));
    });
    return h('div', { className: cx('as-tl', p.className), 'aria-label': p.label || 'Run progress' }, out);
  }

  function LogViewer(p) {
    var lines = p.lines || []; var closed = useState({}); var n = 0;
    var groups = []; lines.forEach(function (l) { var g = l.section || ''; var last = groups[groups.length - 1]; if (!last || last.name !== g) groups.push({ name: g, lines: [] }); groups[groups.length - 1].lines.push(l); });
    var body = [];
    groups.forEach(function (g, gi) {
      var isClosed = !!closed[0][gi];
      if (g.name) body.push(h('button', { key: 'h' + gi, type: 'button', className: 'as-log-sec', 'aria-expanded': isClosed ? 'false' : 'true', onClick: function () { var c = Object.assign({}, closed[0]); c[gi] = !isClosed; closed[1](c); } },
        h(Icon, { name: isClosed ? 'chevR' : 'chevD', size: 'sm' }), g.name, h('span', { style: { color: 'var(--text-dim)' } }, '· ' + g.lines.length)));
      g.lines.forEach(function (l) { n++; if (!isClosed) body.push(h('div', { key: 'l' + n, className: 'as-log-line' }, h('span', { className: 'as-log-n' }, n), h('span', { className: 'as-l-' + (l.tone || 'plain') }, l.text))); });
    });
    return h('div', { className: cx('as-log', p.className) },
      p.toolbar === false ? null : h('div', { className: 'as-log-bar' }, h('span', null, lines.length + ' lines'), h('span', { style: { flex: '1 1 auto' } }), p.streaming ? h(StatusPill, { status: 'running' }, 'Streaming') : null),
      p.reconnecting ? h('div', { className: 'as-log-recon', role: 'status' }, h('span', { className: 'as-spinner' }), h('span', null, h('b', null, 'Reconnecting… '), 'Log stream dropped, lines will resume where they stopped.')) : null,
      h('div', { className: 'as-log-body', role: 'log', 'aria-live': 'polite', style: p.height ? { maxHeight: p.height } : undefined }, body),
      p.onJumpToLatest ? h('button', { type: 'button', className: 'as-jump', onClick: p.onJumpToLatest }, h(Icon, { name: 'down', size: 'sm' }), 'Jump to latest') : null);
  }

  function DiffView(p) {
    var lines = p.lines || []; var add = 0, del = 0;
    lines.forEach(function (l) { if (l.type === 'add') add++; if (l.type === 'del') del++; });
    var signs = { add: '+', del: '−', hunk: '', ctx: '' };
    return h('div', { className: cx('as-diff', p.className) },
      p.path ? h('div', { className: 'as-diff-h' }, h('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.path), h('span', { className: 'as-diff-add' }, '+' + (p.additions !== undefined ? p.additions : add)), h('span', { className: 'as-diff-del' }, '−' + (p.deletions !== undefined ? p.deletions : del)), p.actions || null) : null,
      h('div', { className: 'as-diff-code' }, lines.map(function (l, i) {
        return h('div', { key: i, className: cx('as-dl', l.type && l.type !== 'ctx' && 'as-dl-' + l.type) },
          h('span', { className: 'as-dn' }, l.old !== undefined ? l.old : ''), h('span', { className: 'as-dn' }, l.new !== undefined ? l.new : ''), h('span', { className: 'as-ds' }, signs[l.type || 'ctx']), h('span', { className: 'as-dt' }, l.text));
      })));
  }

  function Skeleton(p) { return h('div', { className: cx('as-skel', p.className), style: { width: p.width || '100%', height: p.height || 12, borderRadius: p.round ? 999 : undefined }, 'aria-hidden': 'true' }); }

  var api = { Button: Button, IconButton: IconButton, Icon: Icon, StatusPill: StatusPill, StatusDot: StatusDot, Badge: Badge, Chip: Chip, Kbd: Kbd, TextField: TextField, Switch: Switch, SegmentedControl: SegmentedControl, Tabs: Tabs, Card: Card, Banner: Banner, Toast: Toast, EmptyState: EmptyState, Dialog: Dialog, NavItem: NavItem, RunTimeline: RunTimeline, LogViewer: LogViewer, DiffView: DiffView, Skeleton: Skeleton };
  window.AgentStudio = Object.assign(window.AgentStudio || {}, api);
})();
