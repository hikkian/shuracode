---
description: Propose a rule about how Shura should work (goes to the night check, never straight into the prompt)
---
Propose a rule for your personal layer from this: $ARGUMENTS

A rule is one short paragraph: when (the situation, under 25 words) -> do (what exactly, checkable, under 40 words),
in the person's own words. Write it in the RULE form first and show it:

RULE
when: ...
do: ...
why: <the person's words, one line>
cost: <words>

If nothing was given after /rule, build it from the correction or the "do it this way" the person just confirmed in this
conversation. When the person answers "yes" (or edits the text), call rule_propose with that key, when, do and why: the rule
is queued for the night check against their control set. It never enters the prompt by itself: enabling is the person's
word after the check. If they say "no", call rule_withdraw so it is not proposed again. Then tell them in one line what
happened (queued / withdrawn / already exists).
