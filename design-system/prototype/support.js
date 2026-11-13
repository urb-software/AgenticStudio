/*
 * support.js — minimal local stand-in for the design-canvas runtime.
 *
 * Lets agent-studio-prototype.dc.html run in a normal browser. Not part of the
 * design system; a viewing shim only.
 *
 * Contract it implements (inferred from the prototype):
 *   <x-dc>
 *     <helmet>…</helmet>        → moved into <head>
 *     template markup            → {{path}} bindings, <sc-if value>, <sc-for list as>
 *   </x-dc>
 *   <script type="text/x-dc" data-dc-script data-props='{…}'>
 *     class Component extends DCLogic { renderVals(){ return {...} } }
 *   </script>
 *
 * DCLogic is a React.Component whose render() evaluates the template against
 * renderVals(). Props come from data-props defaults, overridable via the URL:
 *   ?startTheme=light&startSignedIn=true
 */
(function () {
  'use strict';

  var REACT = 'https://unpkg.com/react@18.3.1/umd/react.production.min.js';
  var REACT_DOM = 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Failed to load ' + src));
      };
      document.head.appendChild(s);
    });
  }

  function domReady() {
    return new Promise(function (resolve) {
      if (document.readyState !== 'loading') resolve();
      else document.addEventListener('DOMContentLoaded', resolve);
    });
  }

  function showError(err) {
    console.error(err);
    var box = document.createElement('pre');
    box.style.cssText =
      'position:fixed;inset:16px auto auto 16px;max-width:calc(100vw - 32px);z-index:99999;' +
      'background:#2a0f12;color:#fecaca;border:1px solid #7f1d1d;border-radius:8px;padding:12px 14px;' +
      'font:12.5px/1.5 ui-monospace,monospace;white-space:pre-wrap';
    box.textContent = 'support.js shim error:\n' + (err && err.stack ? err.stack : String(err));
    document.body.appendChild(box);
  }

  // ---------- binding helpers ----------

  var BIND = /\{\{([\s\S]*?)\}\}/g;
  var SINGLE = /^\{\{([\s\S]*?)\}\}$/;

  function compileExpr(src) {
    var e = src.trim();
    if (e === 'true') return { lit: true };
    if (e === 'false') return { lit: false };
    if (e === 'null') return { lit: null };
    if (e === 'undefined') return { lit: undefined };
    if (/^-?\d+(\.\d+)?$/.test(e)) return { lit: Number(e) };
    if (/^(['"]).*\1$/.test(e)) return { lit: e.slice(1, -1) };
    return { path: e.split('.') };
  }

  function evalExpr(x, scopes) {
    if (!x.path) return x.lit;
    var head = x.path[0],
      v,
      found = false;
    for (var i = 0; i < scopes.length; i++) {
      var sc = scopes[i];
      if (sc != null && typeof sc === 'object' && head in sc) {
        v = sc[head];
        found = true;
        break;
      }
    }
    if (!found) return undefined;
    for (var j = 1; j < x.path.length; j++) {
      if (v == null) return undefined;
      v = v[x.path[j]];
    }
    return v;
  }

  // A value source: static string, single binding (raw value), or interpolation (string).
  function compileValue(str) {
    var m = SINGLE.exec(str);
    if (m && m[1].indexOf('}}') === -1) return { kind: 'bind', expr: compileExpr(m[1]) };
    if (str.indexOf('{{') === -1) return { kind: 'static', value: str };
    var parts = [],
      last = 0,
      mm;
    BIND.lastIndex = 0;
    while ((mm = BIND.exec(str))) {
      if (mm.index > last) parts.push(str.slice(last, mm.index));
      parts.push(compileExpr(mm[1]));
      last = BIND.lastIndex;
    }
    if (last < str.length) parts.push(str.slice(last));
    return { kind: 'interp', parts: parts };
  }

  function toText(v) {
    return v == null || v === false || v === true ? '' : String(v);
  }

  function evalValue(c, scopes) {
    if (c.kind === 'static') return c.value;
    if (c.kind === 'bind') return evalExpr(c.expr, scopes);
    var out = '';
    for (var i = 0; i < c.parts.length; i++) {
      var p = c.parts[i];
      out += typeof p === 'string' ? p : toText(evalExpr(p, scopes));
    }
    return out;
  }

  // ---------- attribute mapping (DOM lowercases names; React wants camelCase) ----------

  var EVENTS = [
    'click',
    'dblclick',
    'change',
    'input',
    'submit',
    'keydown',
    'keyup',
    'keypress',
    'focus',
    'blur',
    'scroll',
    'wheel',
    'mousedown',
    'mouseup',
    'mouseenter',
    'mouseleave',
    'mousemove',
    'mouseover',
    'mouseout',
    'contextmenu',
    'pointerdown',
    'pointerup',
    'pointermove',
    'drag',
    'dragstart',
    'dragend',
    'dragenter',
    'dragleave',
    'dragover',
    'drop',
    'paste',
    'copy',
  ];
  var EVENT_MAP = {};
  EVENTS.forEach(function (e) {
    var camel =
      e === 'dblclick'
        ? 'doubleClick'
        : e.replace(/^(key|mouse|pointer|drag|context)(.)/, function (_, a, b) {
            return a + b.toUpperCase();
          });
    EVENT_MAP['on' + e] = 'on' + camel.charAt(0).toUpperCase() + camel.slice(1);
  });

  var ATTR_MAP = {
    class: 'className',
    for: 'htmlFor',
    tabindex: 'tabIndex',
    autofocus: 'autoFocus',
    autocomplete: 'autoComplete',
    spellcheck: 'spellCheck',
    maxlength: 'maxLength',
    minlength: 'minLength',
    readonly: 'readOnly',
    contenteditable: 'contentEditable',
    crossorigin: 'crossOrigin',
    srcset: 'srcSet',
    enterkeyhint: 'enterKeyHint',
    inputmode: 'inputMode',
    colspan: 'colSpan',
    rowspan: 'rowSpan',
  };
  var BOOL_ATTRS = {
    disabled: 1,
    hidden: 1,
    readOnly: 1,
    required: 1,
    autoFocus: 1,
    multiple: 1,
    checked: 1,
    selected: 1,
  };
  var VOID = {
    area: 1,
    base: 1,
    br: 1,
    col: 1,
    embed: 1,
    hr: 1,
    img: 1,
    input: 1,
    link: 1,
    meta: 1,
    source: 1,
    track: 1,
    wbr: 1,
  };

  function propName(name) {
    if (EVENT_MAP[name]) return EVENT_MAP[name];
    if (ATTR_MAP[name]) return ATTR_MAP[name];
    if (/^(aria|data)-/.test(name)) return name;
    if (name.indexOf('-') !== -1)
      return name.replace(/-([a-z])/g, function (_, c) {
        return c.toUpperCase();
      });
    return name;
  }

  function parseStyle(str) {
    var out = {};
    String(str)
      .split(';')
      .forEach(function (decl) {
        var i = decl.indexOf(':');
        if (i < 0) return;
        var k = decl.slice(0, i).trim(),
          v = decl.slice(i + 1).trim();
        if (!k) return;
        if (k.indexOf('--') !== 0)
          k = k.replace(/-([a-z])/g, function (_, c) {
            return c.toUpperCase();
          });
        out[k] = v;
      });
    return out;
  }

  // ---------- template compiler ----------

  function compileChildren(node) {
    var out = [];
    for (var c = node.firstChild; c; c = c.nextSibling) {
      var n = compileNode(c);
      if (n) out.push(n);
    }
    return out;
  }

  function compileNode(node) {
    if (node.nodeType === 3) {
      return { t: 'text', v: compileValue(node.nodeValue) };
    }
    if (node.nodeType !== 1) return null;
    var tag = node.localName;

    if (tag === 'sc-if') {
      return {
        t: 'if',
        cond: compileValue(node.getAttribute('value') || ''),
        kids: compileChildren(node),
      };
    }
    if (tag === 'sc-for') {
      return {
        t: 'for',
        list: compileValue(node.getAttribute('list') || ''),
        as: node.getAttribute('as') || 'item',
        kids: compileChildren(node),
      };
    }

    var attrs = [],
      hasChangeHandler = false;
    for (var i = 0; i < node.attributes.length; i++) {
      var a = node.attributes[i];
      if (a.name.indexOf('hint-') === 0) continue;
      var name = propName(a.name);
      if (name === 'onChange' || name === 'onInput') hasChangeHandler = true;
      attrs.push({ name: name, v: compileValue(a.value) });
    }
    // Static value/checked with no handler would freeze a controlled input.
    if ((tag === 'input' || tag === 'textarea' || tag === 'select') && !hasChangeHandler) {
      attrs.forEach(function (a) {
        if (a.name === 'value') a.name = 'defaultValue';
        if (a.name === 'checked') a.name = 'defaultChecked';
      });
    }
    var kids = VOID[tag] || tag === 'textarea' ? [] : compileChildren(node);
    if (
      tag === 'textarea' &&
      !attrs.some(function (a) {
        return a.name === 'value' || a.name === 'defaultValue';
      }) &&
      node.textContent
    ) {
      attrs.push({ name: 'defaultValue', v: { kind: 'static', value: node.textContent } });
    }
    return { t: 'el', tag: tag, attrs: attrs, kids: kids };
  }

  // ---------- renderer ----------

  function renderList(nodes, scopes) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var r = renderNode(nodes[i], scopes);
      if (r == null) continue;
      if (Array.isArray(r)) {
        for (var j = 0; j < r.length; j++) out.push(r[j]);
      } else out.push(r);
    }
    return out;
  }

  function renderNode(n, scopes) {
    var R = window.React;
    if (n.t === 'text') return toText(evalValue(n.v, scopes));
    if (n.t === 'if') {
      return evalValue(n.cond, scopes) ? renderList(n.kids, scopes) : null;
    }
    if (n.t === 'for') {
      var list = evalValue(n.list, scopes);
      if (!list || typeof list.length !== 'number') return null;
      var seen = {},
        out = [];
      for (var i = 0; i < list.length; i++) {
        var item = list[i];
        var id =
          item != null && typeof item === 'object' && item.id != null ? 'id:' + item.id : null;
        var key = id && !seen[id] ? id : 'ix:' + i;
        seen[key] = 1;
        var local = {};
        local[n.as] = item;
        out.push(
          R.createElement(R.Fragment, { key: key }, renderList(n.kids, [local].concat(scopes))),
        );
      }
      return out;
    }
    // element
    var props = {};
    for (var k = 0; k < n.attrs.length; k++) {
      var a = n.attrs[k],
        v = evalValue(a.v, scopes);
      if (a.name === 'style') {
        if (v) props.style = typeof v === 'object' ? v : parseStyle(v);
        continue;
      }
      if (a.name.indexOf('on') === 0 && /^on[A-Z]/.test(a.name)) {
        if (typeof v === 'function') props[a.name] = v;
        continue;
      }
      if (a.name === 'ref') {
        if (typeof v === 'function' || (v && typeof v === 'object')) props.ref = v;
        continue;
      }
      if (BOOL_ATTRS[a.name]) {
        v = v === '' || v === a.name.toLowerCase() ? true : v === 'false' ? false : !!v;
      }
      if (a.name === 'value' && v == null) v = '';
      props[a.name] = v;
    }
    var kids = renderList(n.kids, scopes);
    return R.createElement.apply(null, [n.tag, props].concat(kids));
  }

  // ---------- boot ----------

  function readProps(scriptEl) {
    var props = {};
    try {
      var spec = JSON.parse(scriptEl.getAttribute('data-props') || '{}');
      Object.keys(spec).forEach(function (k) {
        if (k.charAt(0) !== '$' && spec[k] && 'default' in spec[k]) props[k] = spec[k]['default'];
      });
    } catch (e) {
      console.warn('support.js: bad data-props', e);
    }
    var q = new URLSearchParams(location.search);
    q.forEach(function (val, k) {
      props[k] = val === 'true' ? true : val === 'false' ? false : val;
    });
    return props;
  }

  Promise.all([
    domReady(),
    loadScript(REACT).then(function () {
      return loadScript(REACT_DOM);
    }),
  ])
    .then(function () {
      var R = window.React;
      var host = document.querySelector('x-dc');
      var scriptEl = document.querySelector('script[data-dc-script]');
      if (!host || !scriptEl) throw new Error('No <x-dc> host or data-dc-script found');

      // Move <helmet> contents (fonts, styles) into <head>.
      var helmet = host.querySelector('helmet');
      if (helmet) {
        while (helmet.firstChild) document.head.appendChild(helmet.firstChild);
        helmet.remove();
      }

      var tree = compileChildren(host);
      host.remove();

      window.DCLogic = class DCLogic extends R.Component {
        render() {
          var vals = typeof this.renderVals === 'function' ? this.renderVals() : {};
          return R.createElement(R.Fragment, null, renderList(tree, [vals]));
        }
      };

      var Component = new Function(
        'React',
        '"use strict";\n' + scriptEl.textContent + '\n;return Component;',
      )(R);

      var mount = document.createElement('div');
      mount.id = 'dc-root';
      document.body.appendChild(mount);
      window.ReactDOM.createRoot(mount).render(R.createElement(Component, readProps(scriptEl)));
    })
    .catch(function (err) {
      domReady().then(function () {
        showError(err);
      });
    });
})();
