/**
 * 清理 chatConfig 中显式为 null 的子项。
 *
 * v4.15 及更早版本会把未配置的 chatConfig 子项存成 null，而 4.17 的 Zod schema
 * 用 z.optional()（只接受 undefined），读取这类历史应用时会抛：
 *   Invalid input: expected object, received null
 *
 * 修复方式是 $unset 掉这些 null 字段，使其变为「字段缺失」= undefined。
 * 不改 schema：把 optional 换成 nullish 会将 null 引入推导类型，
 * 迫使大量下游代码额外处理 null；用 z.preprocess 归一化则会让字段类型退化为
 * unknown 且失去可选性。两者都已实测，改动面远大于清理数据。
 *
 * 4.17 的写入路径不会再产生 null，因此本脚本只需执行一次。
 *
 * 用法（先备份）：
 *   # 1. 把脚本拷进容器（旧版 mongo shell 从 stdin 读会按行解析，
 *   #    块注释与跨行语句都会解析失败，必须用文件方式执行）
 *   docker cp fix-null-chatconfig.js <mongo容器>:/tmp/
 *
 *   # 2. 执行。mongo 6+ 用 mongosh，5 及更早用 mongo
 *   docker exec <mongo容器> mongo -u <user> -p <psw> \
 *     --authenticationDatabase admin fastgpt /tmp/fix-null-chatconfig.js
 *
 * 默认只统计不修改，确认无误后把 DRY_RUN 改为 false 再跑一次。
 */
var DRY_RUN = true;

var FIELDS = [
  'welcomeText', 'welcomeConfig', 'variables', 'autoExecute', 'questionGuide',
  'ttsConfig', 'whisperConfig', 'scheduledTriggerConfig', 'chatInputGuide',
  'fileSelectConfig', 'instruction'
];

['apps', 'app_versions'].forEach(function (coll) {
  print('=== ' + coll + ' ===');
  var c = db.getCollection(coll);

  // 逐字段统计
  var stats = [];
  FIELDS.forEach(function (f) {
    var q = {};
    // 必须用 $type: 'null' 而非 = null：后者在 MongoDB 中同时匹配
    // 「值为 null」和「字段不存在」，会把已清理过的文档也算进来。
    q['chatConfig.' + f] = { $type: 'null' };
    q['chatConfig'] = { $ne: null };
    var n = c.count(q);
    if (n > 0) stats.push({ field: f, count: n });
  });

  if (stats.length === 0) {
    print('   无需处理');
    return;
  }

  stats.forEach(function (s) {
    print('   ' + (DRY_RUN ? '[预演] ' : '[待修] ') + 'chatConfig.' + s.field + ': ' + s.count + ' 条');
  });

  if (DRY_RUN) return;

  // 一次性 $unset 所有目标字段。
  // 不能逐字段 updateMany：每次修改都会改变后续 filter 的匹配集合，
  // 导致只有第一个字段被清掉，其余残留（已在演练中实测到该问题）。
  var orConds = FIELDS.map(function (f) {
    var q = {};
    q['chatConfig.' + f] = { $type: 'null' };
    return q;
  });
  var unset = {};
  FIELDS.forEach(function (f) { unset['chatConfig.' + f] = ''; });

  var res = c.updateMany(
    { chatConfig: { $ne: null }, $or: orConds },
    { $unset: unset }
  );
  // 兼容新旧 shell：mongosh 用 modifiedCount，旧 mongo shell 用 nModified
  var modified = res.modifiedCount !== undefined ? res.modifiedCount : res.nModified;
  print('   已修改 ' + modified + ' 个文档');
});

print('');
print(DRY_RUN
  ? '以上为预演结果。确认无误后把脚本内的 DRY_RUN 改为 false 重新执行。'
  : '清理完成。');
