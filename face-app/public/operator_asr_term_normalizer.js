function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createAsciiPattern(aliases) {
  const values = Array.from(new Set(aliases.filter((alias) => typeof alias === 'string' && alias !== '')));
  if (values.length === 0) {
    return null;
  }
  const body = values.sort((left, right) => right.length - left.length).map((alias) => escapeRegExp(alias)).join('|');
  return new RegExp(`(^|[^A-Za-z0-9])(?:${body})(?=$|[^A-Za-z0-9])`, 'giu');
}

function createKanaPattern(aliases, { allowKanjiAfter = true } = {}) {
  const values = Array.from(new Set(aliases.filter((alias) => typeof alias === 'string' && alias !== '')));
  if (values.length === 0) {
    return null;
  }
  const body = values.sort((left, right) => right.length - left.length).map((alias) => escapeRegExp(alias)).join('|');
  const beforeChars = 'A-Za-z0-9ァ-ヶーｦ-ﾟ';
  const afterChars = allowKanjiAfter ? beforeChars : `${beforeChars}一-龯々〆ヵヶ`;
  return new RegExp(`(^|[^${beforeChars}])(?:${body})(?=$|[^${afterChars}])`, 'gu');
}

function buildRule(replacement, { ascii = [], kana = [], kanaStrict = [] } = {}) {
  const patterns = [];
  const asciiPattern = createAsciiPattern(ascii);
  if (asciiPattern) {
    patterns.push(asciiPattern);
  }
  const kanaPattern = createKanaPattern(kana);
  if (kanaPattern) {
    patterns.push(kanaPattern);
  }
  const kanaStrictPattern = createKanaPattern(kanaStrict, { allowKanjiAfter: false });
  if (kanaStrictPattern) {
    patterns.push(kanaStrictPattern);
  }
  return {
    replacement,
    patterns
  };
}

const OPERATOR_ASR_TERM_RULES = [
  buildRule('GitHub', {
    ascii: ['github'],
    kana: ['ギットハブ', 'ぎっとはぶ', 'ぎっとハブ', 'きっとハブ', 'きっとはぶ', 'ギフトハブ', 'ぎふとはぶ', 'ずっとハブ', 'ずっとはぶ', 'きっと肌', 'きっとはだ', 'ギット肌', 'ぎっとはだ', 'ヒットハガ', 'ひっとはが', 'ヒットハブ', 'ひっとはぶ', 'ヒットハグ', 'ひっとはぐ']
  }),
  buildRule('git', {
    ascii: ['git'],
    kana: ['ギット', 'ぎっと']
  }),
  buildRule('push', {
    ascii: ['push'],
    kanaStrict: ['プッシュ', 'ぷっしゅ']
  }),
  buildRule('pull request', {
    ascii: ['pull request', 'pull-request', 'pullrequest'],
    kana: [
      'プルリクエスト',
      'ぷるりくえすと',
      'プルリク',
      'ぷるりく',
      'プロリクエスト',
      'ぷろりくえすと',
      'プールリクエスト',
      'ぷーるりくえすと',
      'プールリク',
      'ぷーるりく',
      'プロリク',
      'ぷろりく',
      'ブルーリク',
      'ぶるーりく',
      'ブルーリック',
      'ぶるーりっく',
      'グルリク',
      'ぐるりく'
    ]
  }),
  buildRule('branch', {
    ascii: ['branch'],
    kana: ['ブランチ', 'ぶらんち']
  }),
  buildRule('commit', {
    ascii: ['commit'],
    kana: ['コミット', 'こみっと']
  }),
  buildRule('merge', {
    ascii: ['merge'],
    kana: ['マージ', 'まーじ']
  }),
  buildRule('rebase', {
    ascii: ['rebase'],
    kana: ['リベース', 'りべーす']
  }),
  buildRule('stash', {
    ascii: ['stash'],
    kana: ['スタッシュ', 'すたっしゅ']
  }),
  buildRule('checkout', {
    ascii: ['checkout'],
    kana: ['チェックアウト', 'ちぇっくあうと']
  }),
  buildRule('npm', {
    ascii: ['npm'],
    kana: ['エヌピーエム', 'えぬぴーえむ']
  }),
  buildRule('Node.js', {
    ascii: ['node.js', 'nodejs', 'node js'],
    kana: ['ノードジェイエス', 'のーどじぇいえす', 'ノードJS', 'ノードjs', 'のーどJS', 'のーどjs', 'ロードJS', 'ロードjs', 'ろーどJS', 'ろーどjs']
  }),
  buildRule('Docker', {
    ascii: ['docker'],
    kana: ['ドッカー', 'どっかー']
  }),
  buildRule('tmux', {
    ascii: ['tmux'],
    kana: ['ティーマックス', 'てぃーまっくす']
  }),
  buildRule('PR', {
    kanaStrict: ['ピーアール', 'ぴーあーる']
  }),
  buildRule('CI', {
    kanaStrict: ['シーアイ', 'しーあい']
  }),
  buildRule('CD', {
    kanaStrict: ['シーディー', 'しーでぃー']
  }),
  buildRule('SSH', {
    kanaStrict: ['エスエスエイチ', 'えすえすえいち']
  }),
  buildRule('CLI', {
    ascii: ['cli'],
    kanaStrict: ['シーエルアイ', 'しーえるあい']
  }),
  buildRule('API', {
    ascii: ['api', 'ap8'],
    kana: ['エーピーアイ', 'えーぴーあい']
  }),
  buildRule('URL', {
    ascii: ['url'],
    kana: ['ユーアールエル', 'ゆーあーるえる']
  }),
  buildRule('HTTPS', {
    ascii: ['https'],
    kana: ['エイチティーティーピーエス', 'えいちてぃーてぃーぴーえす']
  }),
  buildRule('HTTP', {
    ascii: ['http', 'httpp', 'httpu'],
    kana: ['エイチティーティーピー', 'えいちてぃーてぃーぴー']
  }),
  buildRule('JavaScript', {
    ascii: ['javascript', 'java script'],
    kana: ['ジャバスクリプト', 'じゃばすくりぷと', 'ザバスクリプト', 'ざばすくりぷと']
  }),
  buildRule('TypeScript', {
    ascii: ['typescript', 'type script'],
    kana: ['タイプスクリプト', 'たいぷすくりぷと']
  }),
  buildRule('JSON', {
    ascii: ['json', 'jfn', 'jsyon', 'js-on'],
    kanaStrict: ['ジェイエスオーエヌ', 'じぇいえすおーえぬ', '全SON', 'ジーンスON']
  }),
  buildRule('YAML', {
    ascii: ['yaml'],
    kanaStrict: ['ワイエーエムエル', 'わいえーえむえる', 'ヤムル', 'やむる', 'ヤムロ', 'やむろ', 'ヤグル', 'やぐる', 'ヤムリ', 'やむり', 'ヤブリ', 'やぶり']
  }),
  buildRule('GPU', {
    kanaStrict: ['ジーピーユー', 'じーぴーゆー']
  }),
  buildRule('CPU', {
    kanaStrict: ['シーピーユー', 'しーぴーゆー']
  })
];

const OPERATOR_ASR_PHRASE_REPLACEMENTS = [
  ['試合が通った', 'CIが通った'],
  ['試合通った', 'CI通った'],
  ['しあいが通った', 'CIが通った'],
  ['しあい通った', 'CI通った'],
  ['試合が落ちた', 'CIが落ちた'],
  ['試合落ちた', 'CI落ちた'],
  ['しあいが落ちた', 'CIが落ちた'],
  ['しあい落ちた', 'CI落ちた'],
  ['CIが飛んだら', 'CIが通ったら'],
  ['CIがとんだら', 'CIが通ったら'],
  ['PRを出してCIが通ったらCGします', 'PRを出してCIが通ったらCDします'],
  ['リアルを出してCIが通ったらCGします', 'PRを出してCIが通ったらCDします'],
  ['リアルを出してCIが通ったらCDします', 'PRを出してCIが通ったらCDします'],
  ['問屋新', '通ったら'],
  ['とんやしん', '通ったら'],
  ['ソニー新生', '承認申請'],
  ['そにーしんせい', '承認申請'],
  ['地銀申請', '承認申請'],
  ['じぎん申請', '承認申請'],
  ['じぎんしんせい', '承認申請'],
  ['小児先生お願いします', '承認申請をお願いします'],
  ['ノードセンスでAPI', 'Node.jsでAPI'],
  ['白いからSSH', 'CLIからSSH'],
  ['CIAからSSH', 'CLIからSSH'],
  ['CLYカラーSSH', 'CLIからSSH'],
  ['CNIからSS1', 'CLIからSSH'],
  ['CLIからSS1', 'CLIからSSH'],
  ['CNIからSSH', 'CLIからSSH'],
  ['SC1でCLI', 'SSHでCLI'],
  ['JSON?とやめるを見て', 'JSONとYAMLを見て'],
  ['JSONとやめるを見て', 'JSONとYAMLを見て'],
  ['喉J.S.でAPI', 'Node.jsでAPI'],
  ['CIがどうしたら', 'CIが通ったら'],
  ['CPUとCPUを確認します', 'GPUとCPUを確認します'],
  ['TBAとCPUを確認します', 'GPUとCPUを確認します'],
  ['うわcpuとcpuを確認します', 'GPUとCPUを確認します'],
  ['HTTP確認', 'HTTPを確認'],
  ['HTTPU確認', 'HTTPを確認']
];

export function normalizeOperatorAsrTerms(text, language = 'en') {
  if (typeof text !== 'string' || text === '' || language !== 'ja') {
    return text;
  }

  let next = text;
  for (const rule of OPERATOR_ASR_TERM_RULES) {
    for (const pattern of rule.patterns) {
      next = next.replace(pattern, (match, prefix = '') => `${prefix}${rule.replacement}`);
    }
  }
  for (const [needle, replacement] of OPERATOR_ASR_PHRASE_REPLACEMENTS) {
    next = next.replaceAll(needle, replacement);
  }
  return next;
}
