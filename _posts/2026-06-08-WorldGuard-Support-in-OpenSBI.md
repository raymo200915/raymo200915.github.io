---
layout: post
title: "RISC-V: WorldGuard Support in OpenSBI"
---
# Overview

This post is about the WorldGuard support I recently implemented in
OpenSBI for the RISE (RISC-V Software Ecosystem)
[RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V).

This work follows
[RISC-V: Hardware Isolation Framework in OpenSBI](https://raymo200915.github.io/2026/05/29/Hardware-Isolation-Framework-in-OpenSBI.html),
which introduced the hardware isolation framework, and extends it with
a real mechanism: WorldGuard.

## Deliverable

A concrete WorldGuard mechanism is introduced on top of the hardware
isolation framework with support for:

  - boot-time parsing of WorldGuard checker policy from Devicetree
  - boot-time programming of platform checker MMIO state for
    `sifive,wgchecker2`
  - per-domain parsing of WorldGuard execution metadata
    (`worldguard,wid` / `worldguard,widlist`)
  - runtime reprogramming of WorldGuard hart state on domain exit /
    enter
  - unit-test coverage for both the generic hwiso switch path and the
    WorldGuard-specific checker / CSR state

## Status

Implementation is complete and validated on QEMU virt
(`-M virt,aia=aplic,wg=on`).
The QEMU that supports WorldGuard can be found at [riscv-wg-dts](https://github.com/cwshu/qemu/tree/riscv-wg-dts).

# Background and Motivation

The previous work introduced a mechanism-agnostic hardware
isolation framework in OpenSBI, but the framework alone does not
isolate anything. It only provides the place where mechanism-specific
code can:

  - initialize global isolation hardware,
  - parse per-domain policy,
  - clear mechanism state when leaving a domain, and
  - apply mechanism state when entering a domain.

OpenSBI already uses PMP to constrain CPU-side memory access for each
domain. That is useful, but it remains CPU-local and privilege-centric.
WorldGuard addresses a different problem: system-level access control
based on worlds, so harts and peripherals can be constrained using a
shared hardware policy model.

That means OpenSBI needs to handle two separate but related tasks:

  - configure platform-wide WorldGuard checkers according to the system
    resource policy, and
  - reprogram the current hart's WorldGuard execution state when domain
    ownership changes.

This work adds both pieces on top of the hardware isolation framework.

## Design Goals

1.  Reuse the hardware isolation abstraction.
2.  Parse and program all platform WorldGuard checker devices at boot.
3.  Parse per-domain WorldGuard execution metadata from Devicetree.
4.  Reprogram hart-local WorldGuard state during domain transitions.
5.  Keep generic hwiso tests and WorldGuard-specific tests separated.

## Non-goals

  - Support checker models other than `sifive,wgchecker2`
  - Dynamic reallocation of checker resources after boot

# High-Level Architecture

## Design Overview

The implementation keeps the hardware isolation framework intact.

The generic hardware isolation core is still responsible for:

  - maintaining the list of registered mechanisms
  - calling `init()` during boot
  - calling `domain_init()` for each OpenSBI domain
  - calling `domain_exit()` and `domain_enter()` during domain switch
  - calling `domain_cleanup()` on teardown or error handling

WorldGuard is implemented as one registered mechanism:

```c
static const struct sbi_hwiso_ops worldguard_ops = {
	.name = "sifive,wgchecker2",
	.init = worldguard_init,
	.domain_init = worldguard_domain_init,
	.domain_exit = worldguard_domain_exit,
	.domain_enter = worldguard_domain_enter,
	.domain_cleanup = worldguard_domain_cleanup,
};
```

At a high level, the flow is:

1.  `worldguard_init()` checks whether the platform has any
    `sifive,wgchecker2` nodes and whether any CPU advertises runtime WG
    metadata.
2.  If checker nodes exist, `wgchecker2_init()` parses Devicetree policy
    and programs checker MMIO state.
3.  If CPU runtime metadata exists, `worldguard_domain_init()` parses
    `worldguard,wid` and `worldguard,widlist` for each non-root domain.
4.  During a domain switch, `worldguard_domain_exit()` quiesces the old
    execution state and `worldguard_domain_enter()` applies the new one.

This keeps the mechanism-specific policy in the WorldGuard module while
the generic framework only manages sequencing and storage.

## Split Between Checker Policy and Runtime Hart State

The implementation deliberately splits WorldGuard support into two
independent paths.

Checker programming is platform-wide and happens at boot. Its job is to
translate resource policy in Devicetree into the MMIO programming model
of `wgchecker2`.

Runtime hart-state programming is per-hart and happens during domain
switch. Its job is to update the current execution world's CSR state so
the hart runs with the correct `MLWID`, `MWIDDELEG`, and `SLWID`
configuration.

The important point is that checker-only configurations do not force
runtime switching on. Runtime CSR programming is enabled only when the
Devicetree contains CPU-side WorldGuard execution metadata.

## WorldGuard Runtime Context

The platform-level runtime state is cached as:

```c
struct wg_cpu_defaults {
	u32 trusted_wid;
	u32 nworlds;
	u32 valid_wid_mask;
};

struct worldguard_platform_ctx {
	u32 hart_count;
	bool runtime_enabled;
	struct wg_cpu_defaults *hart_defaults;
};
```

Per-domain state is intentionally small:

```c
struct worldguard_domain_ctx {
	bool has_wid;
	u32 wid;
	u32 widlist_mask;
};
```

This is enough because all checker state is global and boot-time
programmed, while the only per-domain runtime data needed on switch is
the selected WID and delegated WID mask.

## Boot-Time WorldGuard Checker Programming

The checker implementation lives in `platform/generic/wgchecker2.c`.
Its responsibility is to discover all active checker nodes, validate the
policy, and convert that policy into the checker's TOR slot model.

Each checker is modeled with:

```c
struct wgchecker2_checker {
	char name[32];
	u64 mmio_base;
	u64 mmio_size;
	u32 slot_count;
	u32 subordinate_count;
	bool full_checker_rule;
	u64 full_checker_perm;
	u32 range_count;
	struct wgchecker2_range *ranges;
};
```

Boot-time parsing works as follows:

  - discover all nodes compatible with `sifive,wgchecker2`
  - ignore nodes without `sifive,subordinates`, because those do not
    participate in this software path
  - parse `reg` and `sifive,slot-count`
  - walk each protected subordinate resource
  - parse the resource's `worldguard_cfg` child
  - parse `perms` strictly as 64-bit `<hi lo>` pairs
  - use `worldguard_cfg/reg` when present, otherwise fall back to the
    resource node's own `reg`
  - support a full-checker rule when a checker protects exactly one
    subordinate with one permission value and no explicit range list

Before programming hardware, the implementation validates:

  - minimum alignment
  - zero-sized or wrapped ranges
  - overlapping ranges
  - impossible permission / range shapes
  - slot exhaustion

Adjacent ranges with identical permissions are sorted and compacted,
which keeps the final TOR programming minimal.

The checker programming logic is also careful about the update order.
For DRAM checker programming, the reset-time trusted-WID bypass slot is
kept alive until the new rule set has been fully written. Otherwise
OpenSBI could lose access to its own RAM while reprogramming the
checker.

## Runtime WorldGuard Reprogramming on Domain Switch

Runtime programming lives in `platform/generic/worldguard.c`.

The implementation adds support for the WorldGuard-related CSRs and hart
extension flags:

  - `CSR_MLWID`
  - `CSR_MWIDDELEG`
  - `CSR_SLWID`
  - `SBI_HART_EXT_SMWG`
  - `SBI_HART_EXT_SSWG`

The hart extension checks matter because not every platform exposing
checker policy is guaranteed to expose all runtime execution-state CSRs.

### CPU Defaults

CPU-side default WorldGuard execution state is parsed from
`/cpus/cpu@X/worldguard` nodes compatible with `riscv,wgcpu`.

Each hart may define:

  - `mwid`: the fallback machine WID
  - `mwidlist`: the valid / delegable WID set for that hart

If no CPU metadata exists, runtime WorldGuard switching remains
disabled. If the node exists, the parser builds a per-hart default state
and derives a `valid_wid_mask`.

### Per-domain WorldGuard Metadata

When runtime is enabled, each non-root domain is expected to carry a WG
node under its `hw-isolation` container. The current implementation
parses:

  - mandatory `worldguard,wid`
  - optional `worldguard,widlist`

Then it validates the result against every possible hart in that domain.
In other words, a domain cannot request a WID or delegated WID set that
is not supported by one of its possible harts.

### Domain Exit

`worldguard_domain_exit()` quiesces the old domain state by:

  - restoring `MLWID` to the current hart's fallback `mwid`
  - clearing `MWIDDELEG`

This gives OpenSBI a predictable machine-world state before the next
domain is entered.

### Domain Enter

`worldguard_domain_enter()` computes the destination runtime state using
the current hart's valid WID mask and the destination domain context.

The logic is:

1.  Select `MLWID` from the domain's `worldguard,wid` if it is valid on
    this hart; otherwise fall back to the hart default `mwid`.
2.  Compute `MWIDDELEG` from the intersection of the domain's
    `worldguard,widlist` and the hart's valid WID mask.
3.  Select `SLWID` using:
    - the domain `wid` itself if it is delegated,
    - otherwise the lowest delegated WID,
    - otherwise the selected `MLWID`.

The actual CSR writes are gated by hart extensions:

  - if `SMWG` is missing, runtime programming is skipped
  - if `SMWG` exists but `SSWG` is missing, only `MLWID` is written
  - if both exist, `MWIDDELEG` and `SLWID` are also programmed when
    delegation is active

# Devicetree Binding Model

The design uses three layers of Devicetree information:

  - platform checker nodes
  - CPU default WorldGuard execution state
  - per-domain WorldGuard metadata

## Platform Checker Nodes

System resources and checker devices are described in the normal system
topology. A simplified example looks like:

```dts
wgchecker@6000000 {
	compatible = "sifive,wgchecker2";
	reg = <0x0 0x6000000 0x0 0x1000>;
	sifive,slot-count = <16>;
	sifive,subordinates = <&memory0>;
};

memory@80000000 {
	reg = <0x0 0x80000000 0x0 0x40000000>;

	worldguard_cfg {
		reg = <0x0 0x80000000 0x0 0x40000000
		       0x0 0xc0000000 0x0 0x01000000
		       0x0 0xc1000000 0x0 0x3f000000>;
		perms = <0x0 0xcf 0x0 0xcc 0x0 0xcf>;
	};
};
```

This lets OpenSBI build a checker rule set directly from protected
resources instead of hard-coding platform policy in C.

## CPU Default WorldGuard Execution State

CPU default runtime state is described under each CPU:

```dts
cpu@0 {
	...
	worldguard {
		compatible = "riscv,wgcpu";
		mwid = <3>;
		mwidlist = <0 1 3>;
	};
};
```

These values act as the per-hart fallback state used on domain exit and
as the validity mask for runtime delegation decisions.

## Per-domain WorldGuard Metadata

Per-domain metadata lives under the `hw-isolation` container introduced
by the hardware isolation framework work:

```dts
domain@0 {
	compatible = "opensbi,domain,instance";
	...

	hw-isolation {
		worldguard {
			compatible = "sifive,wgchecker2";
			worldguard,wid = <0>;
			worldguard,widlist = <0 1 3>;
		};
	};
};
```

For the current implementation, the compatible string is reused as
`sifive,wgchecker2` so the generic hwiso framework can match the
mechanism cleanly.

# Test Suite and Validation

The final patch series includes both generic hwiso testing and
WorldGuard-specific testing on QEMU virt.

## Generic Hardware Isolation Runtime Test

`lib/sbi/sbi_hwiso_test.c` now exercises a domain-switch sequence using
the generic framework:

  - boot-time test callback
  - failure-mode test callback
  - domain exit / enter sequencing
  - state verification after direct hwiso hook calls
  - state verification after full domain-context entry

## Mechanism-specific WorldGuard Test

`platform/generic/virt/qemu_virt_wgchecker_test.c` adds QEMU-specific
assertions for:

  - three checker instances being programmed as expected
  - per-domain runtime state for `domain@0` and `domain@1`
  - quiesced state after domain exit
  - a failure-mode access test that triggers a store access fault at a
    denied address

The failure-mode test is especially useful because it confirms the
result is not just "registers look right", but that the checker
configuration actually blocks an illegal access.

Representative boot logs look like:

```text
[HWISO] init sifive,wgchecker2
[WG] checker wgchecker@6002000 base=0x6002000 slots=1 rules=0 full-checker
[WG] checker wgchecker@6001000 base=0x6001000 slots=16 rules=0 full-checker
[WG] checker wgchecker@6000000 base=0x6000000 slots=16 rules=3
[HWISO] ops: sifive,wgchecker2, init domain: domain@1
[HWISO] ops: sifive,wgchecker2, init domain: domain@0
```

And representative runtime switch logs look like:

```text
[HWISO] ops: sifive,wgchecker2, domain exit src=domain@0 dst=domain@1
[WG] domain_exit src=domain@0 dst=domain@1 mlwid=3 mwiddeleg=0x0
[HWISO] ops: sifive,wgchecker2, domain enter dst=domain@1 src=domain@0
[WG] domain_enter dst=domain@1 mlwid=1 mwiddeleg=0xa slwid=1
```

This shows the two key pieces of the implementation:

  - checker state was accepted and programmed during boot
  - hart-local WG execution state was reprogrammed during domain switch

# Build Steps and Test Instructions

## Build via Buildroot Project

The complete test environment is prepared in the RP016-M5 Buildroot branch
used for this work.

Get Buildroot source code:

```bash
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b rp016_m5
```

Configure Buildroot:

```bash
$ cd buildroot
$ make qemu_riscv64_virt_optee_defconfig
```

Build:

```bash
$ make -j$(nproc)
```

If your host has CMake newer than 3.30, build with:

```bash
$ make -j$(nproc) CMAKE_POLICY_VERSION_MINIMUM=3.5
```

## Running OpenSBI Hardware Isolation Unit Tests

Start QEMU:

```bash
$ ./output/images/start-qemu-dto.sh
```

This script compiles and applies the test overlay
`qemu-virt-hwiso-overlay.dts` to the dumped QEMU base Devicetree before
restarting QEMU.

At boot, SBIUNIT runs automatically and covers:

  - generic hwiso boot checks
  - a WorldGuard failure-mode access test
  - domain-switch state verification

# Closing Notes

This is where the hardware isolation framework starts doing real
mechanism work.

The important result is not only that a `wgchecker2` parser now exists,
but that OpenSBI has a complete WorldGuard path from Devicetree policy
to actual hardware state:

  - checker MMIO state is programmed at boot
  - per-domain WID metadata is stored in the OpenSBI domain model
  - hart-local WorldGuard execution state is updated when domains switch
  - unit tests verify both expected state and expected failure behavior

That makes the WorldGuard support useful as both a concrete isolation
mechanism and a reference model for how future hardware isolation
engines can plug into the same OpenSBI lifecycle.
