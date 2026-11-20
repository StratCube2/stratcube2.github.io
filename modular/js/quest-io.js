// Conversion between the editor's quest model and FTB Quests .snbt files.
import { questState } from './state.js';
import { newId, toSNBT, shortName } from './utils.js';
import { parseSNBT } from './snbt.js';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function questToSNBTObject(q) {
  return {
    title: q.title,
    subtitle: q.subtitle || undefined,
    description: q.description?.length ? q.description : undefined,
    x: `__RAW__${q.x}d`,
    y: `__RAW__${q.y}d`,
    shape: q.shape && q.shape !== 'default' ? q.shape : undefined,
    dependencies: q.dependencies?.length ? q.dependencies : undefined,
    // Root quests need always_invisible: false so dependency chains load correctly.
    always_invisible: q.dependencies?.length ? undefined : false,
    tasks: q.tasks.map(t => {
      if (t.taskType === 'kill') return { id: t.id, type: 'kill', entity: t.item, value: `__RAW__${t.count || 1}L` };
      if (t.taskType === 'checkmark') return { id: t.id, type: 'checkmark', title: t.item };
      return { id: t.id, type: 'item', item: { id: t.item, Count: '__RAW__1b' }, count: t.count > 1 ? `__RAW__${t.count}L` : undefined };
    }),
    rewards: q.rewards.map(r => {
      if (r.rewardType === 'xp') return { id: r.id, type: 'xp', xp: r.count || 100 };
      if (r.rewardType === 'command') return { id: r.id, type: 'command', command: r.item, player_command: false };
      return { id: r.id, type: 'item', item: { id: r.item, Count: `__RAW__${r.count || 1}b` } };
    }),
    id: q.id
  };
}

/** Returns { 'data.snbt': ..., 'chapter_groups.snbt': ..., 'chapters/<name>.snbt': ... } */
export function buildQuestFiles() {
  const files = {
    'data.snbt': toSNBT({ version: 3, default_quest_shape: '', default_quest_disableable: false }),
    'chapter_groups.snbt': toSNBT({ chapter_groups: [] })
  };
  questState.chapters.forEach(ch => {
    files[`chapters/${ch.filename}.snbt`] = toSNBT({
      id: ch.id,
      group: '',
      order_index: ch.order_index,
      filename: ch.filename,
      title: ch.title || undefined,
      default_quest_shape: '',
      quests: ch.quests.map(questToSNBTObject),
      quest_links: []
    });
  });
  return files;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const asList = v => (Array.isArray(v) ? v : []);
const positive = (v, fallback = 1) => (Number.isFinite(v) && v > 0 ? v : fallback);
const prettify = s => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

const itemId = v => (typeof v === 'string' ? v : v?.id ?? '');
const itemCount = (obj) => obj.count ?? obj.item?.count ?? obj.item?.Count;

function convertTask(t, stats) {
  const id = typeof t.id === 'string' ? t.id : newId();
  switch (t.type) {
    case 'item': {
      const item = itemId(t.item);
      if (item) return { id, item, count: positive(itemCount(t)), taskType: 'item', sourceType: 'collect' };
      break;
    }
    case 'kill':
      if (t.entity) return { id, item: t.entity, count: positive(t.value), taskType: 'kill', sourceType: 'kill' };
      break;
    case 'checkmark':
      return { id, item: t.title || 'Task', count: 1, taskType: 'checkmark', sourceType: 'checkmark' };
  }
  // Task types the editor can't represent (advancement, dimension, location, ...).
  stats.convertedTasks++;
  return { id, item: t.title || prettify(String(t.type || 'task')), count: 1, taskType: 'checkmark', sourceType: 'checkmark' };
}

function convertReward(r, stats) {
  const id = typeof r.id === 'string' ? r.id : newId();
  if (r.type === 'item') {
    const item = itemId(r.item);
    if (item) return { id, item, count: positive(itemCount(r)), rewardType: 'item' };
  } else if (r.type === 'xp') {
    return { id, item: 'XP', count: positive(r.xp, 100), rewardType: 'xp' };
  } else if (r.type === 'command' && r.command) {
    return { id, item: r.command, count: 1, rewardType: 'command' };
  }
  stats.skippedRewards++;
  return null;
}

function convertQuest(q, stats) {
  const tasks = asList(q.tasks).map(t => convertTask(t, stats));
  stats.quests++;
  return {
    id: typeof q.id === 'string' ? q.id : newId(),
    title: q.title || (tasks[0] ? shortName(tasks[0].item) : 'Quest'),
    subtitle: q.subtitle || '',
    description: asList(q.description).map(String),
    x: Number.isFinite(q.x) ? q.x : 0,
    y: Number.isFinite(q.y) ? q.y : 0,
    shape: q.shape || 'default',
    dependencies: asList(q.dependencies).filter(d => typeof d === 'string'),
    tasks,
    rewards: asList(q.rewards).map(r => convertReward(r, stats)).filter(Boolean)
  };
}

/**
 * Converts chapter .snbt files into editor chapters.
 * @param {{ name: string, text: string }[]} entries  name = file name or path, e.g. "chapters/start.snbt"
 * @returns {{ chapters, stats, errors }}
 */
export function parseQuestChapters(entries) {
  const stats = { quests: 0, convertedTasks: 0, skippedRewards: 0 };
  const errors = [];
  const chapters = [];

  for (const { name, text } of entries) {
    const base = name.split('/').pop().replace(/\.snbt$/i, '');
    try {
      const data = parseSNBT(text);
      if (!data || typeof data !== 'object' || !Array.isArray(data.quests)) throw new Error('no quests list');
      chapters.push({
        id: typeof data.id === 'string' ? data.id : newId(),
        filename: data.filename || base,
        title: data.title || prettify(data.filename || base),
        order_index: Number.isFinite(data.order_index) ? data.order_index : chapters.length,
        quests: data.quests.map(q => convertQuest(q, stats))
      });
    } catch (e) {
      errors.push(`${base}.snbt: ${e.message}`);
    }
  }

  chapters.sort((a, b) => a.order_index - b.order_index);
  chapters.forEach((ch, idx) => { ch.order_index = idx; });
  return { chapters, stats, errors };
}

/** Finds chapter files in a list of zip/file paths (any ".../chapters/<name>.snbt"). */
export const isChapterPath = path => /(^|\/)chapters\/[^/]+\.snbt$/i.test(path);

export function describeQuestImport({ chapters, stats, errors }) {
  const parts = [`${chapters.length} chapter${chapters.length === 1 ? '' : 's'}, ${stats.quests} quests`];
  if (stats.convertedTasks) parts.push(`${stats.convertedTasks} unsupported task${stats.convertedTasks === 1 ? '' : 's'} turned into checkmarks`);
  if (stats.skippedRewards) parts.push(`${stats.skippedRewards} unsupported reward${stats.skippedRewards === 1 ? '' : 's'} skipped`);
  if (errors.length) parts.push(`${errors.length} file${errors.length === 1 ? '' : 's'} failed to parse`);
  return parts.join(', ');
}
