---
layout: post
title: "RISC-V: Hardware Isolation Framework in OpenSBI"
---
# Overview

This post is about the design of a hardware isolation framework I
recently implemented in OpenSBI for the RISE (RISC-V Software
Ecosystem) [RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V).

## Deliverable

A system-level hardware isolation framework is introduced in OpenSBI
with abstraction for:

  - registration of multiple isolation mechanisms
  - boot-time mechanism initialization
  - per-domain policy parsing and context creation
  - domain lifecycle callbacks for exit / enter / cleanup
  - a Devicetree binding model for hardware isolation policies
  - a WorldGuard `wgchecker` demo mechanism and unit-test coverage for
    bring-up

## Status

Implementation is complete and validated on QEMU virt
(`-M virt,aia=aplic`), version: 10.1.93.

# Background and Motivation

OpenSBI already has domain management and domain switching, but before
this work it lacked a system-level place to coordinate hardware
isolation state across those domain transitions.

That becomes a problem once a platform wants to combine:

  - multiple execution domains,
  - mechanism-specific isolation hardware,
  - Devicetree-defined per-domain access policies, and
  - runtime domain switches where isolation configuration must change
    together with the domain context.

Without a dedicated framework, each isolation mechanism would need to
hook domain lifecycle events in an ad hoc way, with no shared model for
registration, initialization, per-domain state storage, or cleanup.

The goal of this work is to provide a small, generic framework in
OpenSBI so multiple hardware isolation mechanisms can coexist, parse
their own resources and policies from Devicetree, and apply or clear
their state when domains switch.

## Design Goals

1.  Provide a registration-based system-level isolation framework.
2.  Allow multiple isolation mechanisms to coexist and be invoked in
    order.
3.  Keep default behavior unchanged when no mechanisms are registered.
4.  Maintain Devicetree-driven per-domain isolation policies.
5.  Provide a WorldGuard-based demo mechanism for bring-up and testing.
6.  Ensure domain lifecycle events call into all registered mechanisms.

## Non-goals

  - Real hardware enablement for production isolation devices such as
    WorldGuard or IOPMP

# High-Level Architecture

## Design Overview

The hardware isolation framework provides:

  - a registration API for multiple mechanisms:
    `sbi_hwiso_register()`
  - boot-time initialization for mechanism-global resources:
    `sbi_hwiso_init()`
  - per-domain initialization for isolation policy parsing and
    per-domain context allocation:
    `sbi_hwiso_domain_init()`
  - domain lifecycle callbacks before leaving and after entering a
    domain:
    `sbi_hwiso_domain_exit()` and `sbi_hwiso_domain_enter()`
  - optional per-domain cleanup:
    `sbi_hwiso_domain_cleanup()`

Each domain stores a list of hardware isolation contexts, so every
registered mechanism can preserve its own per-domain state independently
inside `struct sbi_domain`.

## Hardware Isolation Framework Core

### Registration

The framework maintains a registration list of hardware isolation
mechanisms during system initialization. Each mechanism provides a set
of operation hooks describing what it needs across the full domain
lifecycle:

```c
struct sbi_hwiso_ops {
	const char *name;

	/* Boot-time init */
	int (*init)(void *fdt);

	/* Per-domain init, domain_offset refers to domain instance node */
	int (*domain_init)(void *fdt, int domain_offset,
			   struct sbi_domain *dom, void **ctx);

	/* Before switching away from a domain */
	void (*domain_exit)(const struct sbi_domain *src,
			    const struct sbi_domain *dst, void *ctx);

	/* After switching into a domain */
	void (*domain_enter)(const struct sbi_domain *dst,
			     const struct sbi_domain *src, void *ctx);

	/* Cleanup */
	void (*domain_cleanup)(struct sbi_domain *dom, void *ctx);
};
```

This model keeps the framework generic: OpenSBI only manages ordering
and lifecycle, while each mechanism owns the actual hardware-specific
policy handling.

### Initialization

Initialization happens in two stages.

First, `sbi_hwiso_init()` performs boot-time mechanism initialization by
calling `ops->init()`. This is where a mechanism parses its global
resources from Devicetree, such as controlled devices, memory regions,
or hardware instances.

Second, `sbi_hwiso_domain_init()` performs per-domain initialization by
calling `ops->domain_init()` for each domain instance. This is where a
mechanism parses the isolation policy for that specific domain and
creates its per-domain context.

The framework stores that per-domain context using:

```c
struct sbi_hwiso_domain_ctx {
	const struct sbi_hwiso_ops *ops;
	void *ctx;
};
```

As a result, both global resources and per-domain policy state are
prepared before runtime domain switching begins.

### Domain Switch

During a domain switch, the framework calls:

1.  `sbi_hwiso_domain_exit()` before leaving the current domain
2.  `sbi_hwiso_domain_enter()` after entering the next domain

These APIs dispatch to the registered mechanism callbacks
`ops->domain_exit()` and `ops->domain_enter()`.

An optional `sbi_hwiso_domain_cleanup()` path is also available for
mechanisms that need explicit teardown, for example during error
handling or domain destruction.

This structure gives OpenSBI a single system-level path to reprogram
hardware isolation state whenever domain ownership changes.

## Devicetree-binding Model

Hardware isolation policy is represented under the `hw-isolation`
subnode of each domain instance. The content is intentionally
mechanism-specific, so different isolation engines can coexist without
being forced into one shared schema.

A generic example with two mechanisms in one domain looks like:

```dts
domain@1 {
	compatible = "opensbi,domain,instance";
	...

	hw-isolation {
		foo-mechanism {
			compatible = "foo-vendor,foo-mechanism";
			foo-policy = <...>;
		};

		bar-mechanism {
			compatible = "bar-vendor,bar-mechanism";
			bar-policy = <...>;
		};
	};
};
```

A WorldGuard-style binding is used as the demo
policy model. Two domains can carry different `wid` and `widlist`
settings:

```dts
opensbi-domains {
	compatible = "opensbi,domain,config";
	#address-cells = <1>;
	#size-cells = <0>;
	...

	root: domain@0 {
		compatible = "opensbi,domain,instance";
		...

		hw-isolation {
			wg-demo {
				compatible = "sifive,wgchecker2";
				worldguard,wid = <0>;
				worldguard,widlist = <0 1 3>;
			};
		};
	};

	guest0: domain@1 {
		compatible = "opensbi,domain,instance";
		...

		hw-isolation {
			wg-demo {
				compatible = "sifive,wgchecker2";
				worldguard,wid = <1>;
				worldguard,widlist = <1 3>;
			};
		};
	};
};
```

This approach keeps policy description in Devicetree while allowing each
mechanism to interpret its own configuration.

## WorldGuard `wgchecker` Test Mechanism for Demo

To validate the framework before real production hardware support lands,
a lightweight WorldGuard `wgchecker` demo mechanism is added. Its
purpose is not to be the final isolation implementation, but to exercise
the framework end-to-end:

  - registration
  - mechanism-global initialization
  - per-domain policy parsing
  - enter / exit callback ordering

The demo mechanism registers the following operations:

```c
static const struct sbi_hwiso_ops wgchecker_demo_ops = {
	.name = "sifive,wgchecker2",
	.init = wg_demo_init,
	.domain_init = wg_demo_domain_init,
	.domain_exit = wg_demo_domain_exit,
	.domain_enter = wg_demo_domain_enter,
	.domain_cleanup = wg_demo_domain_cleanup,
};
```

This makes it a good bring-up vehicle for validating the framework
without depending on the next milestone.

## Test Suite for Unit Tests

The domain lifecycle validation uses the existing OpenSBI SBIUNIT
framework. A dedicated test suite exercises a domain-switch flow while
hardware isolation is enabled:

```c
static struct sbiunit_test_case hwiso_test_cases[] = {
	SBIUNIT_TEST_CASE(hwiso_domain_switch_test),
	SBIUNIT_END_CASE,
};

SBIUNIT_TEST_SUITE(hwiso_test_suite, hwiso_test_cases);
```

The key point of the test is not only that domain switching happens, but
that each switch runs the registered hardware isolation callbacks in the
expected order and with the expected per-domain policy state.

# Build Steps and Test Instructions

## Build via Buildroot Project

The complete build and test environment is prepared in the RP016-M4
Buildroot branch.

Get Buildroot source code:

```bash
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b rp016_m4
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

All build artifacts are generated under `output/build`.

## Running OpenSBI with Unit Test

Start QEMU:

```bash
./output/images/start-qemu-dto.sh
```

This script compiles and applies the
`qemu-virt-hwiso-overlay.dts` overlay to the dumped QEMU base
Devicetree before restarting QEMU.

At boot, the following representative logs show that the framework and
the WorldGuard demo mechanism are initialized correctly:

```text
[HWISO] init sifive,wgchecker2
[WG] wg_demo_init
[WG] checker wgchecker@100000
[HWISO] ops: sifive,wgchecker2, init domain: domain@1
[WG] wg_demo_domain_init
[WG] domain_init domain@1 wid=1 widlist_count=2
[HWISO] ops: sifive,wgchecker2, init domain: domain@0
[WG] wg_demo_domain_init
[WG] domain_init domain@0 wid=0 widlist_count=3
```

These logs show that:

  - the demo mechanism was registered and initialized,
  - mechanism-global resources were parsed successfully, and
  - per-domain isolation policies were created from Devicetree for
    `domain@0` and `domain@1`

After boot, SBIUNIT runs automatically. The key domain-switch test
produces logs like:

```text
## Running test suite: hwiso_test_suite
[HWISO] ops: sifive,wgchecker2, domain exit src=domain@0 dst=domain@1
[WG] wg_demo_domain_exit
[WG] domain_exit src=domain@0 dst=domain@1
[HWISO] ops: sifive,wgchecker2, domain enter dst=domain@1 src=domain@0
[WG] wg_demo_domain_enter
[WG] domain_enter dst=domain@1 wid=1 widlist=1,3
[HWISO] ops: sifive,wgchecker2, domain exit src=domain@1 dst=root
[WG] wg_demo_domain_exit
[WG] domain_exit src=domain@1 dst=root
[HWISO] ops: sifive,wgchecker2, domain enter dst=root src=domain@1
[WG] wg_demo_domain_enter
[WG] domain_enter dst=root
[PASSED] hwiso_domain_switch_test
1 PASSED / 0 FAILED / 1 TOTAL
```

The test switches domains in the sequence:

`domain@0 -> domain@1 -> root`

During each transition, the logs show the corresponding WorldGuard
policy being cleared from the source domain and applied to the
destination domain. This demonstrates that the hardware isolation
framework is correctly integrated into OpenSBI domain lifecycle
management.

# Closing Notes

This work establishes the framework layer needed for future
mechanism-specific hardware isolation support in OpenSBI. The important
result is not only that a demo mechanism works, but that OpenSBI now has
a consistent system-level model for:

  - registering multiple isolation engines,
  - parsing both global resources and per-domain policy from
    Devicetree, and
  - applying that policy at domain transition boundaries

The next milestone can now build real mechanism support on top of this
foundation instead of inventing its own domain-lifecycle integration
path.
