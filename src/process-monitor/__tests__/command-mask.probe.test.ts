import { describe, expect, it } from 'vitest';
import { maskCommandLine } from '../command-mask';

/**
 * Every credential form the masker recognises, crossed with the ways a command line reaches it: wrappers and
 * prefixes (`sudo -u app`, `env -u X A=1`, `cd /w &&`, `true&&`, `timeout -s KILL 30` …), an operand naming another
 * program before the flag (`https://h/git`), quotes around the value or around flag and value, one- and two-word
 * secrets — read as a space-joined ps line, as one `bash -c` argument, and as exact argv. None may show the secret.
 */
describe('command-mask probe', () => {
  it('no recognised credential leaks in any of the generated forms', () => {
    const VALS = ['hunter2', 'hunter2 swordfish'];
    type Form = { cmd: string; flag: string; kind: 'sep' | 'eq' | 'att' };
    const forms: Form[] = [
      { cmd: 'curl', flag: '-u', kind: 'sep' },
      { cmd: 'curl', flag: '-u', kind: 'att' },
      { cmd: 'curl', flag: '--user', kind: 'eq' },
      { cmd: 'curl', flag: '--proxy-user', kind: 'sep' },
      { cmd: 'redis-cli', flag: '-a', kind: 'sep' },
      { cmd: 'redis-cli', flag: '-a', kind: 'att' },
      { cmd: 'mysql', flag: '-p', kind: 'att' },
      { cmd: 'mysql', flag: '--password', kind: 'eq' },
      { cmd: 'mysql', flag: '--password', kind: 'sep' },
      { cmd: 'tool', flag: '--token', kind: 'sep' },
      { cmd: 'tool', flag: '--token', kind: 'eq' },
      { cmd: 'tool', flag: '--api-key', kind: 'sep' },
      { cmd: 'tool', flag: '--client-secret', kind: 'eq' },
      { cmd: 'docker login', flag: '-p', kind: 'sep' },
      { cmd: 'docker --config /x login', flag: '-p', kind: 'att' },
      { cmd: 'zip', flag: '-P', kind: 'sep' },
      { cmd: '7z a', flag: '-p', kind: 'att' },
      { cmd: 'ldapsearch', flag: '-w', kind: 'sep' },
      { cmd: 'openssl enc', flag: '-k', kind: 'sep' },
      { cmd: 'smbclient //h/s', flag: '-U', kind: 'sep' },
      { cmd: 'sshpass', flag: '-p', kind: 'sep' },
    ];
    const pre = [
      '',
      'sudo -u app ',
      'env -u X A=1 ',
      'nice -n 5 ',
      'cd /w && ',
      'true&&',
      'x;',
      'a|',
      'timeout -s KILL 30 ',
      'exec ',
      'nohup ',
      'command ',
    ];
    const mid = ['', 'https://h/git ', '-v '];
    const quotes = ['', '"', "'"];
    const leaks = new Set<string>();
    const bad = /hunter2|swordfish/;
    let n = 0;
    for (const f of forms)
      for (const p of pre)
        for (const m of mid)
          for (const q of quotes)
            for (const val of VALS) {
              const [prog, ...rest] = f.cmd.split(' ');
              const head = [prog, m.trim(), ...rest].filter(Boolean).join(' ');
              const qf = q ? `${q}${f.flag}${q}` : f.flag;
              const v = `${q}${val}${q}`;
              const forms2 =
                f.kind === 'sep'
                  ? [`${f.flag} ${v}`, `${qf} ${v}`]
                  : f.kind === 'eq'
                    ? [`${f.flag}=${v}`, `${q}${f.flag}=${val}${q}`]
                    : [`${f.flag}${v}`, `${q}${f.flag}${val}${q}`];
              for (const a of forms2) {
                const line = `${p}${head} ${a} https://h -v`;
                n++;
                const j = maskCommandLine({ argv: [line], exact: false });
                if (bad.test(j)) leaks.add(`J  ${line}\n   => ${j}`);
                const bc = maskCommandLine({ argv: ['bash', '-c', line], exact: true });
                if (bad.test(bc)) leaks.add(`BC ${line}\n   => ${bc}`);
              }
              if (!/[;&|]/.test(p)) {
                const argv = [
                  ...p.trim().split(' ').filter(Boolean),
                  ...head.split(' '),
                  ...(f.kind === 'sep' ? [f.flag, val] : f.kind === 'eq' ? [`${f.flag}=${val}`] : [`${f.flag}${val}`]),
                  'https://h',
                  '-v',
                ];
                n++;
                const e = maskCommandLine({ argv, exact: true });
                if (bad.test(e)) leaks.add(`E  ${JSON.stringify(argv)}\n   => ${e}`);
              }
            }
    expect([...leaks].slice(0, 5)).toEqual([]);
    expect(n).toBeGreaterThan(10_000);
    // About a second on an idle machine; room for a loaded CI runner.
  }, 60_000);
});
