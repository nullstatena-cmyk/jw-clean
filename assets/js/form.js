/* ==========================================================================
   Form submission with a browser-side outbox.

   The Cloudflare Worker is the always-up front door and holds the real queue.
   This layer only covers the case where the VISITOR's connection drops mid
   submit: the payload is held in localStorage and retried on the next page
   load, so a lead is not lost to a dead spot in a parking garage.

   Never put an API key or token in this file. It is public.
   ========================================================================== */
(function () {
  'use strict';

  // Set this once the Worker is deployed. See README.
  var ENDPOINT = window.JW_ENDPOINT || '';
  var OUTBOX = 'jw_outbox_v1';

  function readOutbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); }
    catch (e) { return []; }
  }

  function writeOutbox(items) {
    try { localStorage.setItem(OUTBOX, JSON.stringify(items)); }
    catch (e) { /* storage full or blocked — nothing useful to do */ }
  }

  function queue(payload) {
    var items = readOutbox();
    items.push(payload);
    writeOutbox(items.slice(-25));
  }

  function post(payload) {
    return fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // On load, try to clear anything stranded from a previous visit.
  function flush() {
    var items = readOutbox();
    if (!items.length || !ENDPOINT) return;
    var remaining = [];
    var work = items.map(function (item) {
      return post(item).catch(function () { remaining.push(item); });
    });
    Promise.all(work).then(function () { writeOutbox(remaining); });
  }

  function collect(form) {
    var data = { kind: form.dataset.kind || 'contact', submitted_at: new Date().toISOString() };
    var scope = [];
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.name === 'company_website') return;
      if (el.type === 'checkbox') {
        if (el.checked) scope.push(el.value);
      } else {
        data[el.name] = el.value.trim();
      }
    });
    if (scope.length) data.scope = scope;
    return data;
  }

  function setStatus(box, state, message) {
    if (!box) return;
    box.setAttribute('data-state', state);
    box.textContent = message;
  }

  document.querySelectorAll('form[data-jw-form]').forEach(function (form) {
    var box = form.querySelector('.status');
    var button = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      // Honeypot: real people leave this empty, bots fill it.
      if (form.elements.company_website && form.elements.company_website.value) return;

      if (!form.reportValidity()) return;

      var payload = collect(form);
      var label = button ? button.textContent : '';

      if (button) { button.disabled = true; button.textContent = 'Sending…'; }
      setStatus(box, 'pending', 'Sending your request…');

      if (!ENDPOINT) {
        queue(payload);
        setStatus(box, 'queued', 'Saved on this device. The form is not connected to a live endpoint yet.');
        if (button) { button.disabled = false; button.textContent = label; }
        return;
      }

      post(payload)
        .then(function () {
          form.reset();
          setStatus(box, 'ok', 'Request received. Expect a reply within one business day.');
        })
        .catch(function () {
          queue(payload);
          setStatus(box, 'queued', 'No connection right now. Your request is saved and will send automatically next time you open the site. To reach us sooner, call the number in the footer.');
        })
        .then(function () {
          if (button) { button.disabled = false; button.textContent = label; }
        });
    });
  });

  flush();
})();
