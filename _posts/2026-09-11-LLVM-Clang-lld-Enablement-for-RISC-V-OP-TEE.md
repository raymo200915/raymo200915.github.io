---
layout: post
title: "RISC-V: LLVM/Clang + lld Enablement for OP-TEE"
---
# Overview

This post covers the LLVM enablement work completed for
[RISE RP022](https://riscv-optee-docs-c9fea0.gitlab.io/rp022/introduction)
Milestone 2.

I added a Buildroot configuration based on LLVM 22.1.8 so that OP-TEE OS,
`optee_examples`, and `optee_test` TAs are built with Clang and lld on
RISC-V.

The first boot attempts uncovered two OP-TEE OS issues. One caused a hang
before enabling the MMU; the other could trigger a bogus stack-canary
failure when secondary harts were started. Both fixes were submitted in
[OP-TEE OS PR #7890](https://github.com/OP-TEE/optee_os/pull/7890) and
merged upstream on 2026-08-12.

The Buildroot changes are in the RISE
[`rp022-m2` branch](https://gitlab.com/riseproject/riscv-optee/buildroot/-/tree/rp022-m2).

## Deliverable

The work provides:

  - LLVM 22.1.8 packaging updates needed by this Buildroot tree.
  - A `qemu_riscv64_virt_optee_llvm_defconfig` for the RISC-V QEMU virt
    OP-TEE platform.
  - Buildroot wiring that selects host Clang and lld for OP-TEE OS when
    `BR2_PACKAGE_CLANG` is enabled.
  - The same compiler selection for TAs built from the OP-TEE TA Dev Kit,
    including the `optee_examples` and `optee_test` packages.
  - Two upstreamed RISC-V OP-TEE OS fixes that make the LLVM-built image
    boot reliably on a multi-hart QEMU system.
  - End-to-end validation by booting the generated image and running
    `xtest`.

## Status

The LLVM/Clang + lld configuration builds and boots on QEMU RISC-V virt.
It also runs the OP-TEE regression suite through `xtest`, exercising the
normal-world client, OP-TEE OS, and LLVM-built TAs together.

# Background and Motivation

Buildroot is useful for validating a secure-world enablement because it
creates a reproducible, integrated image instead of testing OP-TEE OS in
isolation. It builds the boot chain, Linux, OP-TEE OS, the OP-TEE client
stack, and user-space test content from one configuration.

GCC support remains important, but a RISC-V trusted-execution stack also
needs to work with LLVM. Clang and lld are widely used in kernel,
firmware, and toolchain CI environments. Supporting them exposes hidden
assumptions in assembly, linking, relocation, and early boot code, while
giving integrators a second production-quality toolchain choice.

The goal here is enablement: make the existing RISC-V
OP-TEE software stack build, boot, and run its TAs consistently with
LLVM, then contribute generic fixes upstream.

# Buildroot Changes

## A Dedicated LLVM Defconfig

The new `qemu_riscv64_virt_optee_llvm_defconfig` starts from the existing
QEMU RISC-V OP-TEE configuration and enables Buildroot's Clang package
and host lld.

The Buildroot LLVM packages were updated to LLVM 22.1.8, together with
the host-build adjustments required by this Buildroot baseline. The
defconfig also increases the ext2 root filesystem size to accommodate the
LLVM-enabled image and its test content.

## One Compiler Choice for OP-TEE OS and TAs

Selecting Clang only for OP-TEE OS would leave an important gap: TAs are
separate ELF binaries built through the exported TA Dev Kit. A system
could then boot a Clang-built secure OS while silently compiling its TAs
with a different toolchain.

The Buildroot package rules therefore pass the following selection to
each relevant build when `BR2_PACKAGE_CLANG=y`:

```make
COMPILER=clang
OPTEE_CLANG_COMPILER_PATH="$(HOST_DIR)/bin/"
```

For OP-TEE OS, this selects the Buildroot host Clang/lld flow while
preserving the RISC-V cross-compilation settings and the `ta_rv64` user
TA target. The `optee_examples` and `optee_test` package rules pass the
same options to every TA Dev Kit make invocation. This makes the tested
artifact coherent: secure OS, example TAs, and `xtest` TAs all use the
same LLVM toolchain family.

# LLVM Boot Failures Found in OP-TEE OS

Building successfully is not the end of the work.
LLVM 22.1.8 images reached OP-TEE OS, but exposed failures that
did not appear in the GCC-tested path. The investigation resulted in two
small, architecture-specific fixes that are now merged in OP-TEE OS upstream.

## Early Boot Hang Before the MMU Is Enabled

The first failure stopped during early page-table allocation, with the
last debug messages showing page tables being consumed. The RISC-V entry
path executes before the MMU is enabled, even though relocation may
already have updated dynamic state.

In a PIE/ASLR build, Clang + lld may expand the `la` pseudo-instruction
into a GOT-indirect address calculation. After relocation, the GOT entry
contains a virtual address. Dereferencing that entry before the MMU is
enabled accesses an address that is not yet usable, and the boot flow can
hang.

The fix changes the affected early-entry symbol materialization from
`la` to `lla`. `lla` produces PC-relative addressing and avoids a GOT
load, keeping the pre-MMU path independent of relocated GOT contents.
This is a subtle but important early-boot rule: code executed before the
virtual-address transition must not rely on data that has already been
relocated to virtual addresses.

## False-Positive Stack Canary Failure on Secondary Hart Bring-up

After the early-entry problem was fixed, a second issue could cause a
secondary hart to report `stack smashing detected` during boot.

The primary hart refreshes the global stack-protector guard as part of
boot. Starting a secondary hart before this update has completed creates
a race: the secondary hart may enter a stack-protected function with the
old guard and return after the primary hart has installed the new guard.
The stack check then correctly observes a mismatch, but the mismatch is
caused by boot ordering rather than stack corruption.

The fix serializes these events. Secondary harts are started from the
RISC-V entry path only after the primary hart has updated the global
stack guard. This removes the race and preserves the intended security
property of stack-protector checks.

# Validation

The following commands fetch the RISE Buildroot branch, select the new
LLVM configuration, build the complete image, and run the OP-TEE test
suite on QEMU:

```console
# Fetch buildroot code and build with new LLVM defconfig
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b rp022-m2
$ cd buildroot
$ make qemu_riscv64_virt_optee_llvm_defconfig
$ make -j$(nproc) CMAKE_POLICY_VERSION_MINIMUM=3.5

# Start QEMU
$ ./output/images/start-qemu.sh

# Open a console and telnet to launch the kernel
$ telnet localhost 64320

# Run xtest after kernel login
$ xtest
```

The successful `xtest` run confirms that the LLVM-built boot chain reaches Linux, that normal-world software can open
a TEE session, and that the LLVM-built TA binaries load and execute in
OP-TEE OS.

# Upstreaming and Ecosystem Impact

The two boot fixes were submitted in
[PR #7890](https://github.com/OP-TEE/optee_os/pull/7890) and merged into
the OP-TEE mainline. This matters:

  - Future RISC-V OP-TEE users can use Clang + lld without early-boot failures.
  - The fixes make OP-TEE's pre-MMU code robust against valid LLVM PIE
    address-materialization choices.
  - Correctly ordering stack-guard initialization and secondary-hart
    startup avoids a potential boot race.
  - The Buildroot defconfig gives maintainers and downstream users a
    repeatable regression path covering the secure OS and its TA
    ecosystem together.

The LLVM enablement on OP-TEE improves toolchain diversity, increases test coverage of architecture
assumptions, and strengthens the RISC-V trusted-execution software ecosystem.
