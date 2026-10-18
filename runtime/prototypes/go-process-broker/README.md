# Private Go broker control parser

This source-only prototype parses the version-2 broker control frame. It cannot launch a child, own a job or replace the current PowerShell or C# broker. The compiled selector remains off. No test or build has run yet.

The current parser checks the 1,048,576-byte frame budget, 65,536-token and 524,288-decoded-text-byte config budgets, strict UTF-8, exact top-level fields, duplicate JSON keys, JSON value kinds, required scalar values, protocol version, parent PID, argument array and child environment. Its case-folding of environment names is provisional: Go's Unicode uppercasing is not established as equivalent to the C# broker's ordinal-ignore-case comparison. That difference must be resolved with Windows-specific parity cases before this parser can be used for any supervised child.

The next independent pieces are parent creation-time verification, exact scoped job creation and membership, child creation and identity, stream forwarding, parent-death handling, deadline and error framing, and complete-tree stop. The restricted-token diagnostic that produced a Windows error popup remains stopped. This source alone is not performance or write-footprint evidence.
