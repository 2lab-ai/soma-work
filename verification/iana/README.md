# IANA special-purpose address registries (vendored)

Verbatim copies of the two IANA registries that define which addresses `src/webhook-url-validator.ts`
treats as not globally reachable. Nothing in this directory is edited by hand: to update, fetch the
files again, replace them, and update the tables that transcribe them (below).

| File | Source | SHA-256 |
|---|---|---|
| `iana-ipv4-special-registry-1.csv` | https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv | `e3e39e76d00b1677335db8e9a805c7b9480ea2f4dc9e33f0b93cd3a905128d73` |
| `iana-ipv6-special-registry-1.csv` | https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv | `775feea0621dec8735a44fbf30f762e721e8f0a1b3ab7eb341961a88cfce2139` |

- Fetched 2026-09-29. Both registries' XML versions carried `<updated>2025-10-09</updated>` that day.
- The bytes are exactly as served, CRLF line endings included; `.gitattributes` here (`* -text`)
  keeps Git from converting them. One field in each file spans two lines inside quotes, so read
  them with a CSV parser, not line by line.

## How the validator reads them

Only two columns are used, `Address Block` and `Globally Reachable`.

- `Address Block` can carry a footnote marker (`192.0.0.0/24 [2]`, `2002::/16 [3]`). The marker is
  dropped. One row lists two blocks (`192.0.0.170/32, 192.0.0.171/32`) and becomes two table rows.
- `Globally Reachable` takes the values `True`, `False`, `N/A` or empty, sometimes with a footnote
  marker, which is dropped.
- An address is blocked when the most specific block that contains it says anything other than
  `True`. That makes `N/A` fail-closed, and the empty value too: it appears only on the two
  terminated allocations, `192.88.99.0/24` and `2001:10::/28`.

For IPv6 the registry only decides inside 2000::/3. That block is the only "Global Unicast"
allocation of the IANA IPv6 Address Space registry
(https://www.iana.org/assignments/ipv6-address-space/, `<updated>2025-10-23</updated>` when read
on 2026-09-29); it is a single constant in the validator, so that registry is not vendored. IPv6
outside 2000::/3 is blocked, except the NAT64 well-known prefix 64:ff9b::/96, which takes the
verdict of the IPv4 address in its low 32 bits.

The footnotes, as the registries' XML versions state them (fetched the same day):

| Registry | Marker | Footnote |
|---|---|---|
| IPv4 | [1] (`127.0.0.0/8`) | Several protocols have been granted exceptions to this rule. For examples, see RFC 8029 and RFC 5884. |
| IPv4 | [2] (`192.0.0.0/24`) | Not useable unless by virtue of a more specific reservation. |
| IPv6 | [1] (`2001::/23`) | Unless allowed by a more specific allocation. |
| IPv6 | [2] (`2001::/32`, TEREDO) | See Section 5 of RFC 4380 for details. |
| IPv6 | [3] (`2002::/16`, 6to4) | See RFC 3056 for details. |
| IPv6 | [4] (`fc00::/7`) | See RFC 4193 for more details on the routability of Unique-Local addresses. The Unique-Local prefix is drawn from the IPv6 Global Unicast Address range, but is specified as not globally routed. |

## Where the rows are transcribed, and what checks them

The same rows, in registry order, appear in two places:

- `src/webhook-url-validator.ts`: the exported `IPV4_SPECIAL_PURPOSE` and `IPV6_SPECIAL_PURPOSE`.
- `verification/lean/SomaVerify/WebhookSsrf/Model.lean`: `ipv4Special` and `ipv6Special`.

Both are compared with these files on every run: the Lean tables by the vector generator
(`SomaVerify/WebhookSsrf/Vectors.lean`, which writes nothing on a mismatch), the TS tables by
`src/__tests__/webhook-url-validator.lean-conformance.test.ts`. The vectors in
`verification/vectors/webhook-ssrf.json` also probe the first and last address of every row, and
each of their neighbours, against the real TypeScript.
