/* chat.js - the desk at the end of the flight.
   Live: talks to src/server.py, which runs the assistant on this computer.
   Recorded: without that server (on GitHub Pages, say) the desk replays answers
   the assistant really gave, and labels every one of them as recorded. */
(function () {
  'use strict';

  var desk = document.getElementById('ask');
  if (!desk) return;
  var log = desk.querySelector('.desk__log');
  var form = desk.querySelector('.desk__composer');
  var input = form.querySelector('textarea');
  var sendBtn = form.querySelector('.send');
  var status = desk.querySelector('.desk__status');
  var statusText = status.querySelector('.desk__mode');
  var welcome = log.querySelector('[data-welcome]');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var CODE_URL = 'https://github.com/Munish702/vu-rag-assistant';
  var NOT_FOUND = "I couldn't find this in the VU documents.";
  var HINT = 'Try rephrasing your question, or ask your academic adviser. ' +
             'This assistant only knows the 2026-2027 study guide and exam regulations.';

  // ---- answers the assistant really gave ------------------------------------
  // Copied exactly from its own output. The first two are from the screen
  // recording of the running app (6 October 2026). The third is its answer to
  // the tuition question in the 48-question evaluation run (eval48-rerank),
  // where it declined all 7 questions the documents do not cover.
  var RECORDED = [
    {
      q: 'How is Deep Learning graded?',
      steps: 'Searched 1,102 passages, reranked 33, used 5',
      answer: 'Deep Learning (XM_0083) is graded based on a final exam (50%) and practical assignments (50%). ' +
              'You must pass the final exam with a sufficient grade (equivalent to a grade of 5.5 or higher), ' +
              'and practical assignments cannot be redone if they do not meet the required standard. [1]',
      sources: [{
        n: 1, kind: 'course', tag: 'Course rule: Deep Learning',
        title: 'Deep Learning (XM_0083) - Method of Assessment',
        url: 'https://www.vu.nl/studiegids',
        body: 'Final exam (50%) and practical assignments (50%). There are 4 assignments (2 of them are done individually; 2 of\n' +
              'them are done in groups).\n' +
              'The final exam must be passed with a sufficient grade (equivalent to a grade of 5.5 or higher).\n' +
              'There is a resit for the exam. The practical assignments cannot be redone.'
      }],
      others: 4
    },
    {
      q: 'What IELTS score do I need?',
      steps: 'Searched 1,102 passages, reranked 35, used 5',
      answer: 'You need an IELTS Academic overall score of at least 6.5, with a minimum score of 6.0 for each ' +
              'subcomponent (Listening, Reading, Writing, and Speaking) [1].',
      sources: [{
        n: 1, kind: 'general', tag: 'General rule',
        title: 'Artificial Intelligence TER 2026-2027 - Article 7.2 Admission requirements (part 1/2)',
        url: 'https://www.vu.nl/en/student/teaching-and-examination-regulations-masters-programmes',
        body: '5. Applicants should demonstrate that they have a sufficient level of proficiency in\n' +
              'English by meeting at least one of the following standards:\n' +
              '- IELTS Academic: an overall score of at least 6.5 plus a minimum score of\n' +
              '6.0 for each subcomponent (Listening, Reading, Writing and Speaking);\n' +
              'At the start of the program, the test must not have been taken more than\n' +
              'two years ago.\n' +
              '- TOEFL iBT: an overall score of at least 4.5 plus a minimum score of:\n' +
              'o Listening: 4\no Reading: 4\no Writing: 4\no Speaking: 4',
        excerpt: true
      }],
      others: 4
    },
    {
      q: 'What is the tuition fee for the AI master?',
      steps: 'Searched 1,102 passages, used 5',
      answer: NOT_FOUND,
      abstained: true,
      sources: [],
      others: 0
    }
  ];
  var EXAMPLES = {
    recorded: RECORDED.map(function (r) { return r.q; }),
    live: ['How is Deep Learning graded?', 'What IELTS score do I need?',
           'How quickly do I get my exam results?', 'What is the tuition fee for the AI master?']
  };

  var mode = 'checking';
  var busy = false;
  var seq = 0;

  // ---- small DOM helpers (all text goes in as text, never as HTML) ---------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(path) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.5');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    s.appendChild(p);
    return s;
  }
  var ICON_CHECK = 'M3 8.5 6.5 12 13 4.5';
  var ICON_UP = 'M5 7v6.5H3V7zM5 7l2.6-4.5c.8 0 1.4.7 1.3 1.5L8.5 6.5H12c.8 0 1.4.8 1.2 1.6l-1 4.2c-.2.7-.8 1.2-1.5 1.2H5';
  var ICON_DOWN = 'M5 9V2.5H3V9zM5 9l2.6 4.5c.8 0 1.4-.7 1.3-1.5L8.5 9.5H12c.8 0 1.4-.8 1.2-1.6l-1-4.2c-.2-.7-.8-1.2-1.5-1.2H5';

  function normal(q) { return String(q).toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim(); }

  // The documents' text arrives with the PDF's hard line breaks. Join wrapped
  // lines back into sentences, but keep list items on their own lines.
  function tidy(text) {
    var out = '';
    String(text || '').split('\n').forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var item = /^([-•▪o]\s|\d+\.\s|[a-z][.)]\s)/.test(line);
      if (!out) out = line;
      else if (item) out += '\n' + line;
      else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out += line;
      else out += ' ' + line;
    });
    return out;
  }

  // ---- the log --------------------------------------------------------------
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function toBottom(smooth) {
    log.scrollTo({ top: log.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }

  function addUser(text) {
    var m = el('div', 'msg msg--user msg--enter');
    m.appendChild(el('p', null, text));
    log.appendChild(m);
    toBottom(true);
  }

  function addBot() {
    var id = 'm' + (++seq);
    var m = el('div', 'msg msg--bot msg--enter');
    m.id = id;
    var steps = el('p', 'msg__steps');
    steps.appendChild(el('span', 'spin'));
    var stepText = el('span', null, 'Searching the study guide and regulations');
    steps.appendChild(stepText);
    var body = el('div', 'msg__body');
    m.appendChild(steps);
    m.appendChild(body);
    log.appendChild(m);
    toBottom(true);
    return { id: id, el: m, steps: steps, stepText: stepText, body: body };
  }

  function finishSteps(bot, summary) {
    bot.steps.textContent = '';
    bot.steps.appendChild(icon(ICON_CHECK));
    bot.steps.appendChild(el('span', null, summary));
  }

  function streamTo(bot, text) {
    var stick = nearBottom();
    bot.body.textContent = text;
    bot.body.appendChild(el('span', 'caret'));
    if (stick) toBottom(false);
  }

  // [1] in the answer becomes a chip that opens and lights its source.
  function renderAnswer(bot, text, sources) {
    var known = {};
    sources.forEach(function (s) { known[s.n] = s; });
    bot.body.textContent = '';
    text.split(/(\[\d+\])/).forEach(function (part) {
      var m = /^\[(\d+)\]$/.exec(part);
      if (m && known[+m[1]]) {
        var b = el('button', 'cite-chip', m[1]);
        b.type = 'button';
        b.dataset.src = bot.id + '-s' + m[1];
        b.setAttribute('aria-label', 'Source ' + m[1] + ': ' + known[+m[1]].title);
        bot.body.appendChild(b);
      } else if (part) {
        bot.body.appendChild(document.createTextNode(part));
      }
    });
  }

  function sourceCard(s, mid) {
    var c = el('div', 'src');
    c.id = mid + '-s' + s.n;
    var head = el('div', 'src__head');
    head.appendChild(el('span', 'cite-chip', String(s.n)));
    head.appendChild(el('span', null, s.title));
    c.appendChild(head);
    var tagRow = el('div', 'src__tag');
    tagRow.appendChild(el('span', 'tag tag--' + (s.kind || 'overview'), s.tag || 'Programme overview'));
    c.appendChild(tagRow);
    c.appendChild(el('p', 'src__text', (s.excerpt ? '… ' : '') + tidy(s.body)));
    if (s.url) {
      var a = el('a', 'src__link', 'Open the original document');
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
      c.appendChild(a);
    }
    return c;
  }

  function renderSources(bot, sources, cited, others) {
    var used = sources.filter(function (s) { return cited.indexOf(s.n) !== -1; });
    var rest = sources.filter(function (s) { return cited.indexOf(s.n) === -1; });
    if (!used.length && !rest.length) return;
    var d = el('details', 'srcs');
    d.appendChild(el('summary', null, used.length
      ? (used.length === 1 ? 'Show the source' : 'Show the ' + used.length + ' sources')
      : 'Show the passages that were searched'));
    (used.length ? used : rest).forEach(function (s) { d.appendChild(sourceCard(s, bot.id)); });
    if (used.length && rest.length) {
      var o = el('details', 'other srcs');
      o.appendChild(el('summary', null, 'Other passages that were searched (' + rest.length + ')'));
      rest.forEach(function (s) { o.appendChild(sourceCard(s, bot.id)); });
      d.appendChild(o);
    } else if (others) {
      d.appendChild(el('p', 'srcs__more', others + ' other passage' + (others === 1 ? ' was' : 's were') + ' searched.'));
    }
    bot.el.appendChild(d);
  }

  function renderActions(bot, rec, live) {
    var row = el('div', 'msg__actions');
    var copy = el('button', 'act', 'Copy answer');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy answer'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(rec.answer).then(done, function () {});
    });
    if (live) {
      var thanks = el('span', 'act__thanks');
      var up = el('button', 'act act--icon'), down = el('button', 'act act--icon');
      up.type = down.type = 'button';
      up.appendChild(icon(ICON_UP)); down.appendChild(icon(ICON_DOWN));
      up.setAttribute('aria-label', 'Helpful'); down.setAttribute('aria-label', 'Not helpful');
      up.setAttribute('aria-pressed', 'false'); down.setAttribute('aria-pressed', 'false');
      var rate = function (btn, other, rating) {
        var on = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(on));
        other.setAttribute('aria-pressed', 'false');
        sendFeedback(rec, on ? rating : 'cleared');
        thanks.textContent = on ? 'Thanks, saved on this computer' : '';
      };
      up.addEventListener('click', function () { rate(up, down, 'up'); });
      down.addEventListener('click', function () { rate(down, up, 'down'); });
      row.appendChild(up); row.appendChild(down);
      row.appendChild(copy);
      row.appendChild(thanks);
    } else {
      row.appendChild(copy);
    }
    bot.el.appendChild(row);
  }

  function renderChips(container, questions, label) {
    if (!questions || !questions.length) return;
    if (label) container.appendChild(el('p', 'chips-label', label));
    var box = el('div', 'chips');
    questions.forEach(function (q) {
      var b = el('button', 'chip-q', q);
      b.type = 'button';
      box.appendChild(b);
    });
    container.appendChild(box);
  }

  function finalize(bot, rec, live) {
    renderAnswer(bot, rec.answer, rec.sources);
    if (rec.abstained) bot.el.appendChild(el('p', 'msg__hint', HINT));
    renderSources(bot, rec.sources, rec.cited, rec.others || 0);
    renderActions(bot, rec, live);
    bot.el.removeAttribute('aria-busy');
    toBottom(true);
  }

  function showError(bot, text) {
    bot.steps.remove();
    bot.body.textContent = text;
    bot.el.removeAttribute('aria-busy');
    toBottom(true);
  }

  // ---- live: src/server.py on this computer ---------------------------------
  function runLive(question, bot) {
    var answer = '', sources = [], summary = '', finished = false;
    bot.el.setAttribute('aria-busy', 'true');
    function handle(ev) {
      if (ev.type === 'step') bot.stepText.textContent = ev.text;
      else if (ev.type === 'sources') { sources = ev.sources || []; summary = ev.summary || ''; finishSteps(bot, summary); }
      else if (ev.type === 'token') { answer += ev.text; streamTo(bot, answer); }
      else if (ev.type === 'done') {
        finished = true;
        var rec = { question: question, answer: ev.answer, sources: sources, cited: ev.cited || [],
                    abstained: ev.abstained, ids: sources.map(function (s) { return s.id; }) };
        finalize(bot, rec, true);
        if (!ev.abstained) followUps(bot, rec);
      } else if (ev.type === 'error') { finished = true; showError(bot, ev.text); }
    }
    return fetch('api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question })
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error('The assistant did not answer (' + res.status + ').');
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { if (buf.trim()) handle(JSON.parse(buf)); return; }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function (line) { if (line.trim()) handle(JSON.parse(line)); });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      if (!finished) showError(bot, (err && err.message) || "Couldn't reach the assistant on this computer.");
      finished = true;
    }).then(function () {
      if (!finished) showError(bot, 'The answer stopped halfway. Try asking again.');
    });
  }

  function followUps(bot, rec) {
    fetch('api/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: rec.question, answer: rec.answer, ids: rec.ids })
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.questions || !j.questions.length) return;
      var stick = nearBottom();
      renderChips(bot.el, j.questions, 'You could also ask');
      if (stick) toBottom(true);
    }).catch(function () {});
  }

  function sendFeedback(rec, rating) {
    fetch('api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: rating, question: rec.question, answer: rec.answer, sources: rec.ids })
    }).catch(function () {});
  }

  // ---- recorded: replays real answers, says so on each one -----------------
  function wait(ms) { return new Promise(function (res) { setTimeout(res, reduce ? 0 : ms); }); }

  function runRecorded(question, bot) {
    var rec = null;
    RECORDED.forEach(function (r) { if (normal(r.q) === normal(question)) rec = r; });
    if (!rec) {
      bot.steps.remove();
      bot.body.textContent = "This online copy has no language model, so it can't answer new questions. " +
        'It can replay the real answers below. To ask anything, run the assistant on your own computer: ';
      var a = el('a', null, 'View the code');
      a.href = CODE_URL; a.target = '_blank'; a.rel = 'noopener';
      bot.body.appendChild(a);
      bot.body.appendChild(document.createTextNode('.'));
      renderChips(bot.el, EXAMPLES.recorded, 'Recorded answers');
      toBottom(true);
      return Promise.resolve();
    }
    var label = el('span', 'msg__label', 'Recorded answer');
    bot.el.insertBefore(label, bot.steps);
    bot.stepText.textContent = 'Replaying a recorded answer';
    bot.el.setAttribute('aria-busy', 'true');
    return wait(650).then(function () {
      finishSteps(bot, rec.steps);
      var tokens = rec.answer.match(/\S+\s*/g) || [rec.answer];
      var shown = '';
      var i = 0;
      return new Promise(function (res) {
        if (reduce) { res(); return; }
        (function next() {
          if (i >= tokens.length) { res(); return; }
          shown += tokens[i++];
          streamTo(bot, shown);
          setTimeout(next, 32);
        })();
      });
    }).then(function () {
      var cited = [];
      (rec.answer.match(/\[(\d+)\]/g) || []).forEach(function (m) { cited.push(+m.slice(1, -1)); });
      finalize(bot, { question: rec.q, answer: rec.answer, sources: rec.sources, cited: cited,
                      abstained: rec.abstained, others: rec.others }, false);
    });
  }

  // ---- asking ---------------------------------------------------------------
  function setBusy(v) {
    busy = v;
    sendBtn.disabled = v || !input.value.trim();
    [].forEach.call(log.querySelectorAll('.chip-q'), function (b) { b.disabled = v; });
  }

  function ask(question) {
    question = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!question || busy) return;
    if (mode === 'checking') { decided.then(function () { ask(question); }); return; }
    setBusy(true);
    addUser(question);
    var bot = addBot();
    var run = mode === 'live' ? runLive(question, bot) : runRecorded(question, bot);
    run.then(function () { setBusy(false); }, function () { setBusy(false); });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = input.value;
    if (!q.trim() || busy) return;
    input.value = '';
    autosize();
    ask(q);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  });
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    sendBtn.disabled = busy || !input.value.trim();
  }
  input.addEventListener('input', autosize);
  // the long example does not fit one line on a phone
  var narrow = matchMedia('(max-width: 760px)');
  function fitPlaceholder() {
    input.placeholder = narrow.matches ? 'Ask a question' : 'Ask a question, e.g. Can I resit an exam I already passed?';
  }
  fitPlaceholder();
  if (narrow.addEventListener) narrow.addEventListener('change', fitPlaceholder);

  log.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip-q');
    if (chip && !chip.disabled) { ask(chip.textContent); return; }
    var cite = e.target.closest('button.cite-chip');
    if (cite) openSource(cite.dataset.src);
  });

  function openSource(id) {
    var card = document.getElementById(id);
    if (!card) return;
    for (var d = card.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    card.classList.remove('is-flash');
    void card.offsetWidth;
    card.classList.add('is-flash');
    card.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    setTimeout(function () { card.classList.remove('is-flash'); }, 1600);
  }

  // ---- which mode -----------------------------------------------------------
  function setExamples(list) {
    var box = welcome.querySelector('[data-examples]');
    box.textContent = '';
    list.forEach(function (q) {
      var b = el('button', 'chip-q', q);
      b.type = 'button';
      box.appendChild(b);
    });
  }

  function setMode(m, info) {
    mode = m;
    status.setAttribute('data-mode', m);
    if (m === 'live') {
      var model = info && info.llm ? info.llm : 'a local model';
      statusText.textContent = info && info.ready === false ? 'Live, loading models' : 'Live on this computer';
      status.title = 'Answers come from ' + model + ', running on this computer.';
      setExamples(EXAMPLES.live);
      if (info && info.ready === false) setTimeout(poll, 3000);
    } else {
      statusText.textContent = 'Recorded answers';
      status.title = 'No language model is running here, so the desk replays real answers the assistant gave.';
      welcome.querySelector('[data-recorded-note]').hidden = false;
      setExamples(EXAMPLES.recorded);
    }
    setBusy(false);
  }

  function health() {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 2500);
    return fetch('api/health.json', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (j) {
        clearTimeout(timer);
        if (!j || j.ok !== true) throw new Error('not the assistant');
        return j;
      });
  }
  function poll() {
    health().then(function (j) {
      if (j.ready) statusText.textContent = 'Live on this computer';
      else setTimeout(poll, 3000);
    }, function () {});
  }

  var decided = health().then(function (j) { setMode('live', j); }, function () { setMode('recorded'); });
})();
