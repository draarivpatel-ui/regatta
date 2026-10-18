// Regatta video runtime. Turns a page of scenes into a video that can be shown at any instant.
// Loaded by every video's index.html. Do not edit inside a video folder: Regatta replaces it.
//
// The page shows one <section data-scene> at a time. Time comes only from seek(t): every CSS
// animation inside the visible scene is paused and set to the scene's own clock, onSeek listeners
// draw anything else, and the caption for that instant is shown. Nothing moves on its own, so the
// same t always gives the same picture.
;(function () {
  'use strict'

  var meta = document.querySelector('meta[name="regatta-video"]')
  var config = { width: 1280, height: 720, fps: 30 }
  if (meta) {
    String(meta.getAttribute('content') || '')
      .split(',')
      .forEach(function (pair) {
        var parts = pair.split('=')
        var key = (parts[0] || '').trim()
        var value = Number((parts[1] || '').trim())
        if ((key === 'width' || key === 'height' || key === 'fps') && value > 0) config[key] = value
      })
  }
  var mode = new URLSearchParams(location.search).get('mode') === 'render' ? 'render' : 'player'

  var errors = []
  window.addEventListener('error', function (event) {
    errors.push(String((event && event.message) || 'Script error'))
  })
  window.addEventListener('unhandledrejection', function (event) {
    errors.push('Unhandled promise rejection: ' + String(event && event.reason))
  })

  var stage = null
  var scenes = []
  var total = 0
  var captions = []
  var captionBox = null
  var listeners = []
  var current = null

  function collect() {
    stage = document.getElementById('stage') || document.body
    scenes = Array.prototype.slice.call(document.querySelectorAll('section[data-scene]')).map(function (el) {
      var duration = Number(el.getAttribute('data-duration'))
      return {
        el: el,
        id: el.getAttribute('data-scene') || '',
        title: el.getAttribute('data-title') || el.getAttribute('data-scene') || '',
        duration: duration > 0 ? duration : 0,
        start: 0
      }
    })
    total = 0
    scenes.forEach(function (scene) {
      scene.start = total
      total += scene.duration
    })
    var data = document.getElementById('regatta-captions')
    captions = []
    if (data) {
      try {
        var parsed = JSON.parse(data.textContent || '[]')
        if (Array.isArray(parsed)) {
          captions = parsed
            .filter(function (c) {
              return c && typeof c.text === 'string' && Number(c.end) > Number(c.start)
            })
            .map(function (c) {
              return { start: Number(c.start), end: Number(c.end), text: c.text }
            })
        }
      } catch (err) {
        errors.push('Captions are not valid JSON: ' + String(err && err.message))
      }
    }
    if (captions.length > 0) {
      captionBox = document.createElement('div')
      captionBox.className = 'rv-captions'
      var line = document.createElement('div')
      line.className = 'rv-caption'
      captionBox.appendChild(line)
      stage.appendChild(captionBox)
    }
  }

  function fit() {
    if (!stage || stage === document.body) return
    stage.style.width = config.width + 'px'
    stage.style.height = config.height + 'px'
    if (mode === 'render') {
      stage.style.transform = 'none'
      return
    }
    var scale = Math.min(window.innerWidth / config.width, window.innerHeight / config.height)
    var left = (window.innerWidth - config.width * scale) / 2
    var top = (window.innerHeight - config.height * scale) / 2
    stage.style.transform = 'translate(' + left + 'px, ' + top + 'px) scale(' + scale + ')'
  }

  function sceneAt(t) {
    for (var i = 0; i < scenes.length; i++) {
      var s = scenes[i]
      if (t >= s.start && t < s.start + s.duration) return s
    }
    return scenes[scenes.length - 1] || null
  }

  function seekSync(t) {
    if (scenes.length === 0) return null
    var time = Math.max(0, Math.min(Number(t) || 0, total - 1e-6))
    var active = sceneAt(time)
    for (var i = 0; i < scenes.length; i++) {
      var on = scenes[i] === active
      scenes[i].el.style.display = on ? 'block' : 'none'
      if (on) scenes[i].el.setAttribute('data-active', '')
      else scenes[i].el.removeAttribute('data-active')
    }
    // Reading layout makes the newly shown scene's CSS animations exist before we pin them.
    void active.el.offsetWidth
    var local = time - active.start
    var animations = document.getAnimations()
    for (var j = 0; j < animations.length; j++) {
      var a = animations[j]
      var target = a.effect && a.effect.target
      if (!target || !active.el.contains(target)) continue
      a.pause()
      // Before its start an animation shows its first frame; after its end it holds the last.
      a.effect.updateTiming({ fill: 'both' })
      a.currentTime = local * 1000
    }
    for (var k = 0; k < listeners.length; k++) {
      try {
        listeners[k](time, active.id, local)
      } catch (err) {
        errors.push('onSeek: ' + String(err && err.message))
      }
    }
    if (captionBox) {
      var text = ''
      for (var c = 0; c < captions.length; c++) {
        if (time >= captions[c].start && time < captions[c].end) {
          text = captions[c].text
          break
        }
      }
      captionBox.firstChild.textContent = text
      captionBox.style.visibility = text ? 'visible' : 'hidden'
    }
    current = time
    return active.id
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        resolve()
      })
    })
  }

  function seek(t) {
    var id = seekSync(t)
    return nextFrame()
      .then(nextFrame)
      .then(function () {
        return id
      })
  }

  /** A small seeded random number generator (mulberry32) that returns numbers in [0, 1). */
  function random(seed) {
    var a = (Number(seed) || 1) >>> 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      var x = Math.imul(a ^ (a >>> 15), 1 | a)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }

  function wavBase64(buffer) {
    var channels = buffer.numberOfChannels
    var frames = buffer.length
    var rate = buffer.sampleRate
    var bytes = new Uint8Array(44 + frames * channels * 2)
    var view = new DataView(bytes.buffer)
    function text(offset, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
    }
    text(0, 'RIFF')
    view.setUint32(4, 36 + frames * channels * 2, true)
    text(8, 'WAVE')
    text(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * channels * 2, true)
    view.setUint16(32, channels * 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, frames * channels * 2, true)
    var data = []
    for (var c = 0; c < channels; c++) data.push(buffer.getChannelData(c))
    var offset = 44
    for (var f = 0; f < frames; f++) {
      for (var ch = 0; ch < channels; ch++) {
        var sample = Math.max(-1, Math.min(1, data[ch][f]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
    }
    var binary = ''
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  /** Renders the music the page defines with RegattaVideo.score, as base64 WAV. Null without one. */
  function renderAudio() {
    var score = window.RegattaVideo && window.RegattaVideo.score
    if (typeof score !== 'function' || total <= 0) return Promise.resolve(null)
    var rate = 48000
    var ctx = new OfflineAudioContext(2, Math.ceil(rate * total), rate)
    try {
      score(ctx, total, { random: random })
    } catch (err) {
      errors.push('score: ' + String(err && err.message))
      return Promise.resolve(null)
    }
    return ctx.startRendering().then(wavBase64)
  }

  function selectorFor(el, scene) {
    var parts = []
    var node = el
    while (node && node !== scene && node.nodeType === 1 && parts.length < 4) {
      if (node.id) {
        parts.unshift('#' + node.id)
        break
      }
      var part = node.tagName.toLowerCase()
      var classes = Array.prototype.slice.call(node.classList).filter(function (c) {
        return c.indexOf('rv-') !== 0
      })
      if (classes.length) part += '.' + classes.slice(0, 2).join('.')
      var parent = node.parentElement
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName
        })
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
    }
    if (scene) parts.unshift('section[data-scene="' + scene.getAttribute('data-scene') + '"]')
    return parts.join(' > ')
  }

  /** What is drawn at stage coordinates (x, y): a short selector, its text and the scene. */
  function inspect(x, y) {
    var rect = stage.getBoundingClientRect()
    var scale = rect.width / config.width || 1
    var el = document.elementFromPoint(rect.left + x * scale, rect.top + y * scale)
    if (!el || el === stage || el === document.body) return null
    var scene = el.closest('section[data-scene]')
    return {
      selector: selectorFor(el, scene),
      text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      tag: el.tagName.toLowerCase(),
      scene: scene ? scene.getAttribute('data-scene') : null,
      time: current
    }
  }

  var api = {
    width: config.width,
    height: config.height,
    fps: config.fps,
    mode: mode,
    duration: 0,
    scenes: [],
    captions: [],
    errors: errors,
    score: null,
    seek: seek,
    seekSync: seekSync,
    renderAudio: renderAudio,
    inspect: inspect,
    random: random,
    onSeek: function (fn) {
      if (typeof fn === 'function') listeners.push(fn)
    },
    ready: null
  }
  window.RegattaVideo = api

  api.ready = new Promise(function (resolve) {
    function start() {
      document.documentElement.setAttribute('data-rv-mode', mode)
      collect()
      api.duration = total
      api.scenes = scenes.map(function (s) {
        return { id: s.id, title: s.title, start: s.start, duration: s.duration }
      })
      api.captions = captions.slice()
      if (scenes.length === 0) errors.push('No scenes: add <section data-scene="..." data-duration="..."> elements.')
      fit()
      window.addEventListener('resize', fit)
      var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
      fonts.then(function () {
        seek(0).then(function () {
          resolve(true)
        })
      })
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
    else start()
  })
})()
