// AI 日报投递 —— 在应用打开时把 GitHub 上生成的日报同步成收件箱里的一条任务。
var DIGEST_URL = 'https://raw.githubusercontent.com/fenghuangyuan1412/ai-daily-digest/main/digest/latest.json';
var INBOX_PROJECT_ID = 'INBOX_PROJECT';
var TAG_LABEL = 'AI日报';
var STATE_KEY = 'imported';
var CHECK_INTERVAL_MS = 30 * 60 * 1000;

var _timer = null;

var readState = async function () {
  try {
    return JSON.parse((await PluginAPI.loadSyncedData(STATE_KEY)) || '{}');
  } catch (e) {
    return {};
  }
};

var writeState = function (state) {
  return PluginAPI.persistDataSynced(JSON.stringify(state), STATE_KEY);
};

var ensureTag = async function () {
  var tags = await PluginAPI.getAllTags();
  var existing = tags.filter(function (t) { return t.label === TAG_LABEL; })[0];
  if (existing) return existing.id;
  return PluginAPI.addTag({ label: TAG_LABEL });
};

// 日报正文自带一级标题，与任务标题重复，去掉后再补一行数据来源。
var buildNotes = function (digest) {
  var body = String(digest.markdown || '')
    .split('\n')
    .filter(function (line, i) { return !(i === 0 && /^#\s/.test(line)); })
    .join('\n')
    .replace(/^\s+/, '');
  return (
    body +
    '\n\n---\n\n' +
    '_由 [ai-daily-digest](https://github.com/fenghuangyuan1412/ai-daily-digest) 每日 09:00 (北京时间) 生成，' +
    '生成时间 ' +
    String(digest.generatedAt || '').replace('T', ' ').slice(0, 16) +
    ' UTC。_'
  );
};

var importDigest = async function () {
  var digest = await PluginAPI.request(DIGEST_URL);
  if (!digest || !digest.date || !digest.markdown) {
    PluginAPI.log.warn('[AI日报] 返回内容不完整，跳过', digest && Object.keys(digest));
    return;
  }

  var state = await readState();
  if (state.lastDate && state.lastDate >= digest.date) return;

  var tagId = await ensureTag();
  await PluginAPI.addTask({
    title: '📰 AI 日报 · ' + digest.date,
    projectId: INBOX_PROJECT_ID,
    tagIds: [tagId],
    dueDay: digest.date,
    notes: buildNotes(digest),
  });

  await writeState({ lastDate: digest.date, importedAt: new Date().toISOString() });
  PluginAPI.showSnack({
    msg: 'AI 日报已投递到收件箱（' + (digest.itemCount || 0) + ' 条）',
    type: 'SUCCESS',
  });
  PluginAPI.log.info('[AI日报] 已投递 ' + digest.date);
};

var runQuietly = function () {
  importDigest().catch(function (e) {
    PluginAPI.log.warn('[AI日报] 同步失败，将在下次重试：' + (e && e.message ? e.message : e));
  });
};

PluginAPI.onReady(function () {
  runQuietly();
  _timer = setInterval(runQuietly, CHECK_INTERVAL_MS);
});

PluginAPI.onUnload(function () {
  if (_timer) clearInterval(_timer);
  _timer = null;
});
