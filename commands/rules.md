---
description: Show personal rules, status and passports (source, date, trust)
---
$ARGUMENTS

Without arguments: call rule_list and show every rule on one line each as the tool prints it: key, status, model, cases, cost, and the passport (source, date, trust) when present. Preserve the passport verbatim.
Statuses: candidate = one case so far (a note, not a rule); queued = waits for the night check; testing / passed = being or
done measured; enabled = in your personal layer now; rejected / retired = declined or taken out. With a word after /rules
that is a status, pass it as the filter; with a rule key, call rule_show and show the full RULE form with its cases and history.
`/rules versions` calls rule_versions and lists the versions of the personal layer (number, date, rules, which one is live).
`/rules rollback` shows the versions and tells the person the exact terminal command for one step back:
`python3 <shuracode>/mcp/rules.py rollback --model <model>` (or `--to NNN`); you never run it yourself.
`/rules merge <a> <b>` drafts ONE rule that replaces the two (same RULE form) and, after the person's "yes", calls rule_merge;
the merged rule goes to the night check and the sources retire only when the person enables it.
Do not change any rule here and do not run the rules script yourself: /rule proposes one, rule_withdraw declines one, and
enabling, retiring or rolling back is the person's own terminal command (see the Rules section of the README).
