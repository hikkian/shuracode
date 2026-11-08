---
description: Show the rules of the personal layer and their status
---
$ARGUMENTS

Without arguments: call rule_list and show every rule on one line each as the tool prints it: key, status, model, cases, cost.
Statuses: candidate = one case so far (a note, not a rule); queued = waits for the night check; testing / passed = being or
done measured; enabled = in your personal layer now; rejected / retired = declined or taken out. With a word after /rules
that is a status, pass it as the filter; with a rule key, call rule_show and show the full RULE form with its cases and history.
Do not change any rule here and do not run the rules script yourself: /rule proposes one, rule_withdraw declines one, and
enabling or retiring is the person's own terminal command (see the Rules section of the README).
