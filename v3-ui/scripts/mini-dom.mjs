// 极简 DOM 垫片：只为在 Node 里把构建产物 mount 起来做冒烟验证。
//
// 背景：宿主是浏览器环境，直接 import ui/page.js 后调用 mount(el, ctx)；
// 本地没有浏览器，也没有为此引入 jsdom 之类的依赖（保持离线可重复的构建底座干净）。
// 这里手写够用的 DOM 子集：Vue 的运行时只用到节点创建/插入/删除、属性、文本、
// 事件监听这几类操作，naive-ui 的组件在挂载阶段也只用这些。
//
// 这不是通用 DOM 实现，只服务于 v3-ui/scripts/smoke-mount.mjs 的冒烟检查。

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8
const DOCUMENT_NODE = 9
const DOCUMENT_FRAGMENT_NODE = 11

class Node {
  constructor(nodeType) {
    this.nodeType = nodeType
    this.parentNode = null
    this.childNodes = []
    this.ownerDocument = null
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.childNodes
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === ELEMENT_NODE)
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child)
    const index = this.childNodes.indexOf(reference)
    if (index < 0) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    return child
  }

  replaceChild(next, previous) {
    const index = this.childNodes.indexOf(previous)
    if (index < 0) return previous
    if (next.parentNode) next.parentNode.removeChild(next)
    next.parentNode = this
    this.childNodes.splice(index, 1, next)
    previous.parentNode = null
    return previous
  }

  contains(other) {
    if (other === this) return true
    return this.childNodes.some((child) => child.contains(other))
  }
}

class TextNode extends Node {
  constructor(data) {
    super(TEXT_NODE)
    this.data = String(data)
  }

  get textContent() {
    return this.data
  }

  set textContent(value) {
    this.data = String(value)
  }
}

class CommentNode extends Node {
  constructor(data) {
    super(COMMENT_NODE)
    this.data = String(data)
  }

  get textContent() {
    return this.data
  }

  set textContent(value) {
    this.data = String(value)
  }
}

class Element extends Node {
  constructor(tagName) {
    super(ELEMENT_NODE)
    this.tagName = String(tagName).toUpperCase()
    this.localName = String(tagName).toLowerCase()
    this.attributes = new Map()
    this.style = createStyle()
    this.classList = createClassList(this)
    this._listeners = new Map()
    this._value = ''
  }

  get id() {
    return this.getAttribute('id') ?? ''
  }

  set id(value) {
    this.setAttribute('id', value)
  }

  get className() {
    return this.getAttribute('class') ?? ''
  }

  set className(value) {
    this.setAttribute('class', value)
  }

  get innerHTML() {
    return this.childNodes.map((node) => serialize(node)).join('')
  }

  set innerHTML(value) {
    this.childNodes = []
    this._value = String(value)
  }

  get outerHTML() {
    return serialize(this)
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent ?? '').join('')
  }

  set textContent(value) {
    this.childNodes = []
    if (value !== '' && value != null) {
      const text = new TextNode(value)
      text.ownerDocument = this.ownerDocument
      this.appendChild(text)
    }
  }

  getAttribute(name) {
    const key = String(name).toLowerCase()
    return this.attributes.has(key) ? this.attributes.get(key) : null
  }

  setAttribute(name, value) {
    this.attributes.set(String(name).toLowerCase(), String(value))
  }

  removeAttribute(name) {
    this.attributes.delete(String(name).toLowerCase())
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase())
  }

  getAttributeNames() {
    return [...this.attributes.keys()]
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(handler)
  }

  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler)
  }

  dispatchEvent(event) {
    const handlers = this._listeners.get(event?.type)
    if (!handlers) return true
    for (const handler of handlers) handler(event)
    return true
  }

  querySelector(selector) {
    return querySelectorAll(this, selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return querySelectorAll(this, selector)
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }

  focus() {}
  blur() {}
  click() {
    this.dispatchEvent({ type: 'click', target: this })
  }

  setPointerCapture() {}
  releasePointerCapture() {}
  scrollIntoView() {}
}

class TextAreaElement extends Element {
  constructor() {
    super('textarea')
  }

  get value() {
    return this._value
  }

  set value(next) {
    this._value = String(next)
  }
}

class Document extends Node {
  constructor() {
    super(DOCUMENT_NODE)
    this.ownerDocument = this
    this.documentElement = new Element('html')
    this.documentElement.ownerDocument = this
    this.head = new Element('head')
    this.body = new Element('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
  }

  createElement(tagName) {
    const element = tagName === 'textarea' ? new TextAreaElement() : new Element(tagName)
    element.ownerDocument = this
    return element
  }

  createElementNS(_namespace, tagName) {
    return this.createElement(tagName)
  }

  createTextNode(data) {
    const node = new TextNode(data)
    node.ownerDocument = this
    return node
  }

  createComment(data) {
    const node = new CommentNode(data)
    node.ownerDocument = this
    return node
  }

  createDocumentFragment() {
    const fragment = new Element('#fragment')
    fragment.nodeType = DOCUMENT_FRAGMENT_NODE
    fragment.ownerDocument = this
    return fragment
  }

  getElementById(id) {
    const target = String(id)
    const walk = (node) => {
      if (node.nodeType === ELEMENT_NODE && node.getAttribute('id') === target) return node
      for (const child of node.childNodes) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this)
  }

  querySelector(selector) {
    return querySelectorAll(this, selector)[0] ?? null
  }

  querySelectorAll(selector) {
    return querySelectorAll(this, selector)
  }
}

/**
 * 极简选择器匹配：只支持 css-render 与 Vue 用到的几种写法。
 *
 * css-render 用 `style[cssr-id="xxx"]` 找已挂载的样式节点；Vue 的运行时也会用
 * `tag`、`[attr]`、`[attr="value"]`、逗号分组。够用即可，不是通用实现。
 */
function matchSimple(element, selector) {
  const trimmed = selector.trim()
  if (!trimmed) return false

  // 标签名
  if (/^[a-z][a-z0-9-]*$/i.test(trimmed)) {
    return element.localName === trimmed.toLowerCase()
  }

  // .class
  if (/^\.[-\w]+$/.test(trimmed)) {
    return element.classList.contains(trimmed.slice(1))
  }

  // tag.class
  const tagClassMatch = /^([a-z][a-z0-9-]*)\.([-\w]+)$/i.exec(trimmed)
  if (tagClassMatch) {
    return element.localName === tagClassMatch[1].toLowerCase() && element.classList.contains(tagClassMatch[2])
  }

  // [attr] / [attr="value"] / [attr='value']
  const attrMatch = /^\[([a-zA-Z_:][-\w:.]*)(?:([~^$*|]?=)"([^"]*)"|([~^$*|]?=)'([^']*)')?\]$/.exec(trimmed)
  if (attrMatch) {
    const name = attrMatch[1].toLowerCase()
    const value = attrMatch[3] ?? attrMatch[5]
    if (value === undefined) return element.hasAttribute(name)
    return element.getAttribute(name) === value
  }

  // 标签名[attr="value"]
  const tagAttrMatch = /^([a-z][a-z0-9-]*)\[([a-zA-Z_:][-\w:.]*)(?:="([^"]*)")?\]$/i.exec(trimmed)
  if (tagAttrMatch) {
    if (element.localName !== tagAttrMatch[1].toLowerCase()) return false
    const name = tagAttrMatch[2].toLowerCase()
    if (tagAttrMatch[3] === undefined) return element.hasAttribute(name)
    return element.getAttribute(name) === tagAttrMatch[3]
  }

  return false
}

function querySelectorAll(root, selector) {
  const groups = String(selector).split(',').map((part) => part.trim()).filter(Boolean)
  const results = []
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === ELEMENT_NODE) {
        if (groups.some((group) => matchSimple(child, group))) results.push(child)
        walk(child)
      }
    }
  }
  walk(root)
  return results
}

// Vue 的 runtime-dom 用 style.setProperty / style.removeProperty / style[name] 写样式。
function createStyle() {
  const values = new Map()
  return {
    setProperty(name, value) {
      values.set(String(name), String(value))
    },
    removeProperty(name) {
      values.delete(String(name))
    },
    getPropertyValue(name) {
      return values.get(String(name)) ?? ''
    },
    get cssText() {
      return [...values.entries()].map(([name, value]) => `${name}: ${value};`).join(' ')
    },
    set cssText(text) {
      values.clear()
      for (const rule of String(text).split(';')) {
        const [name, value] = rule.split(':')
        if (name && value) values.set(name.trim(), value.trim())
      }
    },
  }
}

function createClassList(element) {
  const read = () => (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  const write = (list) => element.setAttribute('class', list.join(' '))
  return {
    add(...names) {
      const list = read()
      for (const name of names) if (!list.includes(name)) list.push(name)
      write(list)
    },
    remove(...names) {
      write(read().filter((name) => !names.includes(name)))
    },
    contains(name) {
      return read().includes(name)
    },
    toggle(name, force) {
      const has = read().includes(name)
      const next = force === undefined ? !has : force
      if (next) this.add(name)
      else this.remove(name)
      return next
    },
  }
}

function serialize(node) {
  if (node.nodeType === TEXT_NODE) return node.data
  if (node.nodeType === COMMENT_NODE) return `<!--${node.data}-->`
  if (node.nodeType !== ELEMENT_NODE) return node.childNodes.map(serialize).join('')
  const attrs = [...node.attributes.entries()].map(([name, value]) => ` ${name}="${value}"`).join('')
  const inner = node.childNodes.map(serialize).join('')
  return `<${node.localName}${attrs}>${inner}</${node.localName}>`
}

/**
 * 装一套最小 DOM 到 globalThis，返回 document。
 */
export function installMiniDom() {
  const document = new Document()
  const window = {
    document,
    navigator: { userAgent: 'v3-ui-smoke', language: 'zh-CN', platform: 'linux' },
    location: { href: 'https://localhost/', origin: 'https://localhost' },
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  }
  window.window = window
  window.self = window
  window.globalThis = window

  // Node 24 的 navigator 是只读 getter，只能用 defineProperty 覆盖。
  const define = (name, value) => {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }

  define('window', window)
  define('document', document)
  define('navigator', window.navigator)
  define('location', window.location)
  define('requestAnimationFrame', window.requestAnimationFrame)
  define('cancelAnimationFrame', window.cancelAnimationFrame)
  define('matchMedia', window.matchMedia)
  define('getComputedStyle', window.getComputedStyle)
  define('Element', Element)
  define('Node', Node)
  define('Text', TextNode)
  define('HTMLElement', Element)
  define('SVGElement', Element)
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }
  globalThis.Event = class Event {
    constructor(type) {
      this.type = type
    }
  }
  globalThis.MutationObserver = class MutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.CSS = { supports: () => false }
  if (!globalThis.SVGElement.prototype.getBBox) {
    globalThis.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 })
  }
  if (!globalThis.SVGElement.prototype.getTotalLength) {
    globalThis.SVGElement.prototype.getTotalLength = () => 0
  }
  if (!globalThis.SVGElement.prototype.getPointAtLength) {
    globalThis.SVGElement.prototype.getPointAtLength = () => ({ x: 0, y: 0 })
  }

  return document
}

export { Document, Element, TextNode }
