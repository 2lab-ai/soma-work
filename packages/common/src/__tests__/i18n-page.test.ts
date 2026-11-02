import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { decodeJsString, registerPageCatalog, scanPage, segmentContext, translatePage } from '../i18n-page';

const keys = (html: string) => scanPage(html).map((s) => [s.kind, s.key, !!s.skip]);

describe('scanPage', () => {
  it('finds HTML text, attributes, script strings, template chunks and CSS strings', () => {
    const html =
      '<html lang="ko"><head><title>__p 대시보드</title><style>.x::after{content:"__p 끝"}</style></head>' +
      '<body><button title="__p 새 작업 (N)">__p 새 작업</button><!-- __p 주석 -->' +
      "<script>var a = '__p 보관함'; var b = `__p 총 ${n + `__p 안`}개`; // __p 주석\n</script></body></html>";
    expect(keys(html)).toEqual([
      ['text', '__p 대시보드', false],
      ['css', '__p 끝', false],
      ['attr', '__p 새 작업 (N)', false],
      ['text', '__p 새 작업', false],
      ['js', '__p 보관함', false],
      ['tpl', '__p 총 ', false],
      ['tpl', '__p 안', false],
      ['tpl', '개', false],
    ]);
  });

  it('marks strings the code compares against as data', () => {
    const html =
      "<script>if (x === '__p 완료') y(); switch (s) { case '__p 대기': break; }" +
      "if (l.indexOf('__p 제목: ') === 0) t = l.slice('__p 제목: '.length); var m = { '__p 키': 1, k: c ? '__p 예' : '__p 아니오' };</script>";
    expect(keys(html)).toEqual([
      ['js', '__p 완료', true],
      ['js', '__p 대기', true],
      ['js', '__p 제목: ', true],
      ['js', '__p 제목: ', true],
      ['js', '__p 키', true],
      ['js', '__p 예', false],
      ['js', '__p 아니오', false],
    ]);
  });

  it('is not fooled by regex literals, comments or escaped quotes', () => {
    const html =
      "<script>var r = /'[가-힣]+'/g; /* '__p 아님' */ var s = 'it\\'s __p 맞음'; var d = a / b; var e = '__p 다음';</script>";
    expect(keys(html)).toEqual([
      ['js', "it's __p 맞음", false],
      ['js', '__p 다음', false],
    ]);
  });

  it('decodes \\u escapes, so escaped Korean is found too', () => {
    expect(decodeJsString('\\uB300\\uC2DC\\uBCF4\\uB4DC')).toBe('대시보드');
    expect(keys("<script>t('\\uB300\\uC2DC\\uBCF4\\uB4DC')</script>")).toEqual([['js', '대시보드', false]]);
  });
});

describe('translatePage', () => {
  registerPageCatalog({
    '__q 새 작업': '__q New "task"',
    '__q 보관함': "__q It's </script> `x` ${y}",
    일: 'days',
  });

  it('ko is the page unchanged', () => {
    const html = '<p>__q 새 작업</p>';
    expect(translatePage(html, 'ko')).toBe(html);
  });

  it('escapes each replacement for where it sits, and the scripts still parse', () => {
    const html =
      '<html lang="ko"><body><p title="__q 새 작업">__q 새 작업</p><ui-menu lang="ko"></ui-menu>' +
      '<button onclick="go(\'__q 보관함\')">x</button>' +
      '<script>var a = \'__q 보관함\'; var b = "__q 보관함"; var c = `__q 보관함`;</script></body></html>';
    const out = translatePage(html, 'en');
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('<ui-menu lang="en">');
    expect(out).toContain('<p title="__q New &quot;task&quot;">__q New "task"</p>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(out)![1];
    const sf = ts.createSourceFile('x.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics).toEqual([]);
    const values: string[] = [];
    new Function('out', `${script}; out.push(a, b, c);`)(values);
    expect(values).toEqual(Array(3).fill("__q It's </script> `x` ${y}"));
    expect(out).not.toContain("go('__q 보관함')");
  });

  it('a key@@context entry wins where the code before it matches, even when empty', () => {
    const html = "<script>var u = n + '일'; var d = m + '월 ' + Number(d) + '일';</script>";
    const seg = scanPage(html);
    const ctx = segmentContext(html, seg[2]);
    expect(ctx.endsWith("+ '월 ' + Number(d) +")).toBe(true);
    registerPageCatalog({ [`일@@${ctx}`]: '' });
    expect(translatePage(html, 'en')).toBe("<script>var u = n + 'days'; var d = m + '월 ' + Number(d) + '';</script>");
  });

  it('leaves a JSON data block (a conversation) byte for byte; a block that opts in is page text', () => {
    const data = '<script type="application/json" id="conv-data">{"turns":[{"text":"__q 새 작업"}]}</script>';
    expect(translatePage(data, 'en')).toBe(data);
    const tabs = '<script type="application/json" id="settings-tabs-data" data-i18n>{"label":"__q 새 작업"}</script>';
    expect(translatePage(tabs, 'en')).toBe(
      '<script type="application/json" id="settings-tabs-data" data-i18n>{"label":"__q New \\"task\\""}</script>',
    );
    const auth = '<script type="application/json" data-auth-state>{"hint":"__q 새 작업"}</script>';
    expect(JSON.parse(/>([^<]*)</.exec(translatePage(auth, 'en'))![1])).toEqual({ hint: '__q New "task"' });
  });
});
