const OWNER = 'raymondmaoca@gmail.com';
const SITE = 'https://raymo200915.github.io';
const props = () => PropertiesService.getScriptProperties();
const sheet = name => SpreadsheetApp.openById(props().getProperty('sheet')).getSheetByName(name);
const rows = name => sheet(name).getDataRange().getValues().slice(1);
const posts = () => JSON.parse(UrlFetchApp.fetch(SITE + '/reader-posts.json').getContentText());

function locked_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

function setup_() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  props().setProperty('sheet', book.getId());
  const tables = {
    Comments: ['Post', 'Name', 'Message', 'Status', 'Submitted at'],
    Likes: ['Post', 'Browser'],
    Subscribers: ['Email', 'Token', 'Status', 'Seen URLs']
  };
  Object.entries(tables).forEach(([name, headers]) => {
    if (!book.getSheetByName(name)) book.insertSheet(name).appendRow(headers);
  });
  const submittedHeader = book.getSheetByName('Comments').getRange('E1');
  if (submittedHeader.isBlank()) submittedHeader.setValue('Submitted at');
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'notify_'))
    ScriptApp.newTrigger('notify_').timeBased().everyHours(1).create();
}

function doGet(e) {
  const page = HtmlService.createTemplateFromFile('Reader');
  page.mode = ['post','contact','subscribe','confirm','unsubscribe'].includes(e.parameter.mode)
    ? e.parameter.mode : 'subscribe';
  page.post = e.parameter.post || '';
  page.token = e.parameter.token || '';
  return page.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function field_(s, max) {
  if (typeof s !== 'string' || !s.trim() || s.length > max) throw Error('Check the form fields.');
  return s.trim();
}
function email_(s) {
  s = field_(s, 254).toLowerCase();
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s)) throw Error('Check your email address.');
  return s;
}
function link_(mode, token) {
  return ScriptApp.getService().getUrl() + '?mode=' + mode + '&token=' + token;
}
function feedback(post) {
  return {
    likes: rows('Likes').filter(r => r[0] === post).length,
    comments: rows('Comments').filter(r => r[0] === post && r[3] === 'approved')
      .map(r => [String(r[1]), String(r[2]), r[4] instanceof Date ? r[4].toISOString() : null])
  };
}
function submit(action, d) {
  if (action === 'contact') {
    MailApp.sendEmail({to: OWNER, subject: 'Blog contact: ' + field_(d.name,100),
      replyTo: email_(d.email), body: field_(d.message,5000) + '\n\nFrom: ' + d.email});
    return 'Message sent.';
  }
  return locked_(() => {
    if (action === 'like' || action === 'comment') {
      const post = field_(d.post,1000);
      if (!posts().some(p => p.url === SITE + post)) throw Error('Unknown article.');
      if (action === 'like') {
        const id = field_(d.browser,64);
        if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error('Invalid browser ID.');
        if (!rows('Likes').some(r => r[0] === post && r[1] === id))
          sheet('Likes').appendRow([post,id]);
        return 'Like recorded.';
      }
      const name = field_(d.name,100);
      const message = field_(d.message,5000);
      const comments = sheet('Comments');
      comments.appendRow([post,"'" + name,"'" + message,'pending',new Date()]);
      SpreadsheetApp.flush();
      try {
        const reviewUrl = comments.getParent().getUrl() + '#gid=' + comments.getSheetId();
        MailApp.sendEmail(OWNER, 'Blog comment awaiting approval', [
          'A new comment from ' + name + ' is awaiting your review.',
          'Post: ' + SITE + post,
          message,
          'Review the comment in your private Comments sheet: ' + reviewUrl,
          'To publish it, change its Status from pending to approved.'
        ].join('\n\n'));
      } catch (error) {
        // The comment is saved even if the notification cannot be delivered.
        console.error('Comment moderation notification failed: ' + error.message);
      }
      return 'Thank you. Your comment is awaiting approval.';
    }
    const subscribers = rows('Subscribers');
    const table = sheet('Subscribers');
    if (action === 'subscribe') {
      const email = email_(d.email);
      if (/^[=+\-']/.test(email)) throw Error('Unsupported email address.');
      const existing = subscribers.find(r => r[0] === email);
      if (!existing || existing[2] === 'pending') {
        const token = existing ? existing[1] : Utilities.getUuid();
        if (!existing) table.appendRow([email,token,'pending','[]']);
        MailApp.sendEmail(email,'Confirm your subscription to Raymond Mao',
          [
            'Hello,',
            'I received a request to subscribe this email address to my GitHub blog (' + SITE + '/).',
            'If you would like an email whenever I publish a new post, please open the link below and select "Confirm subscription".',
            link_('confirm',token),
            'If you did not request this subscription, please ignore this email. You will only receive blog updates if you confirm.',
            'Best regards,\nRaymond Mao'
          ].join('\n\n'));
      }
      return 'Check your inbox for confirmation if you are not already subscribed.';
    }
    const i = subscribers.findIndex(r => r[1] === d.token && d.token);
    if (i < 0) throw Error('This link is no longer active.');
    if (action === 'unsubscribe') {
      table.deleteRow(i+2);
      return 'You have unsubscribed.';
    }
    if (action !== 'confirm') throw Error('Unknown action.');
    if (subscribers[i][2] === 'pending')
      table.getRange(i+2,3,1,2).setValues([['active',JSON.stringify(posts().map(p => p.url))]]);
    return 'Your subscription is active.';
  });
}

function notify_() {
  const published = posts().reverse();
  for (const [email,token,status] of rows('Subscribers')) {
    if (status !== 'active') continue;
    locked_(() => {
      const list = rows('Subscribers');
      const i = list.findIndex(r => r[1] === token);
      if (i < 0) return;
      const seen = new Set(JSON.parse(list[i][3]));
      for (const p of published) {
        if (seen.has(p.url)) continue;
        MailApp.sendEmail(email,'New post: ' + p.title,p.title + '\n' + p.url +
          '\n\nUnsubscribe: ' + link_('unsubscribe',token));
        seen.add(p.url);
        sheet('Subscribers').getRange(i+2,4).setValue(JSON.stringify([...seen]));
        SpreadsheetApp.flush();
      }
    });
  }
}
