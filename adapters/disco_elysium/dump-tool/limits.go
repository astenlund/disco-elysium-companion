package main

const (
	maxArchiveBytes        int64 = 1_073_741_824
	maxDirectoryRecords          = 65_536
	maxDirectoryBytes      int64 = 67_108_864
	maxRetainedNameBytes   int64 = 16_777_216
	maxRequiredMemberBytes int64 = 268_435_456
	maxTLVDepth                  = 61
	// Expected count of `TASK.`-prefixed Boolean variables in the dialogue variable
	// store; a content-signature discriminator derived from Disco Elysium save data
	// (the vendored task DB also holds 1,131 entries). A game patch that adds or removes
	// a task changes this count and requires an explicit dump/adapter version update,
	// so it is named here rather than embedded anonymously at the probe site.
	expectedTaskVariableCount = 1_131
	// Dump container-depth caps, one apart. The standalone header/world member
	// admission walker caps at 63 because embedding a member beneath the dump root
	// adds one container level (producing a depth-64 dump); the assembled-output
	// validator counts the root and therefore caps at 64. Keep them exactly this
	// far apart; never collapse them to one value.
	maxStandaloneContainerDepth = 63
	maxAssembledContainerDepth  = 64
	// The dump TLV stream holds exactly five top-level tables; the parser output
	// gate and the assembled-output allTables validator both compare against this.
	expectedTopLevelTableCount       = 5
	maxTLVDecodedValues              = 2_000_000
	maxTLVProjectedEntries           = 1_000_000
	maxTLVRetainedTextBytes    int64 = 67_108_864
	maxDumpOutputBytes         int64 = 16_777_216
	maxDumpOutputTokens              = 2_000_000
	maxDumpOutputTextBytes     int64 = 8_388_608
)
