---
layout: post
title: "Enable CI on Firmware Handoff & Measured Boot"
---
# Overview

Firmware security features such as Measured Boot and Firmware Handoff
are inherently cross-component by design. They span multiple boot stages
across TF-A, OP-TEE, U-Boot and kernel. However, for a long time, the
upstream open-source ecosystem lacked continuous integration (CI)
coverage that verifies these features end-to-end across the full boot
chain.

In other words, each project had unit-level or component-local test
coverage, but no CI pipeline existed that boots a real system flow and
validates the integrity of these features across TF-A / OP-TEE / U-Boot.

This created a blind spot: any change in one project could silently
break another, and developers would not notice until much later.

To address this, I introduced Measured Boot and Firmware Handoff testing
in U-Boot and OP-TEE CI, where:

- TF-A is built with Measured Boot / Firmware Handoff enabled, generating
Transfer List with multiple Transfer Entries includes Device Tree and
TCG2 Event Log;

- OP-TEE appends the Device Tree and handoff the complete Transfer List;

- U-Boot includes support for TCG2/TPM2 with Firmware Handoff / Measured
Boot enabled to consume the Device Tree / Event Log and extend PCRs.

# U-Boot CI Enablement

A QEMU-based CI test pipeline boots the full firmware chain, extracts
and verifies:

  - Firmware Handoff consistency across stages

  - Transfer List and Transfer Entries structure

  - Device Tree structure

  - Event Log structure and log entries

## Part1: Refactor and Extend U-Boot Test Hooks

For this purpose, I refactored and extended U-Boot Test Hooks,
including:

  - Clean-up of technical debts: grouping the QEMU boot arguments, add
    hook for invoking helper setup script.

  - Logic to reuse a default config file for multiple boards when no
    board ident is specified. This helps to avoid creating duplicated
    config files.

  - Flash image assembling and different QEMU machine/kernel arguments
    to adapt running with TF-A or U-Boot-only modes.

  - Board environment file to introduce variable for controlling
    Firmware Handoff / Measured Boot tests.

Patch series link:

[Test Hooks prerequisite patch for Firmware Handoff CI test](https://patchwork.ozlabs.org/project/uboot/list/?series=476181&state=%2A&archive=both)

## Part2: U-Boot Changes in Docker / Pytest / CI pipelines 

To introduce and enable the new CI tests, my patch series includes:

  - Fetch MbedTLS (v3.6), OP-TEE (v4.7.0) and TF-A (v2.13.0) in docker image.

  - Build OP-TEE and MbedTLS with both Firmware Handoff and Measured
    Boot enabled.

  - Pytest to validate the Firmware Handoff feature via bloblist by
    checking the existence of expected Device Tree nodes and TPM events
    generated and handed over from TF-A / OP-TEE.

    > The nodes `reserved-memory` and `firmware` appended by OP-TEE
    > indicates a successful Device Tree handoff, while the events
    > `SECURE_RT_EL3`, `SECURE_RT_EL1_OPTEE` and
    > `SECURE_RT_EL1_OPTEE_EXTRA1` created by TF-A indicates a
    > successful Event Log handoff.

  - Azure and Gitlab pipeline changes to copy artifacts and trigger the
    pytests.

Patch series link:

[Enable Firmware Handoff CI test on qemu_arm64 \[v5\]](https://patchwork.ozlabs.org/project/uboot/list/?series=478791&state=%2A&archive=both)

## Run pytest in local host

Please follow the instructions in "[Run U-Boot CI Pipeline on Your Host](https://raymo200915.github.io/2025/09/01/run-uboot-ci-tests-on-your-host.html)" if you want to run the pytest under docker container of your local host.

# OP-TEE CI Enablement

I also enbaled Firmware Handoff CI test on OP-TEE pipeline by below patch series, a set of PTA self test was appended and triggered by Xtest 1001.

[OP-TEE/optee_os#7352: Add pta self test for firmware handoff](https://github.com/OP-TEE/optee_os/pull/7352)

[OP-TEE/optee_os#7385: ci: QEMUv8: check Firmware Handoff](https://github.com/OP-TEE/optee_os/pull/7385)

[OP-TEE/optee_test#788: xtest: add test entry for transfer list](https://github.com/OP-TEE/optee_test/pull/788)

[OP-TEE/build#821: qemu_v8: add build for enabling Firmware Handoff](https://github.com/OP-TEE/build/pull/821)

[OP-TEE/manifest#321: qemu_v8: Update U-Boot to v2025.07-rc1](https://github.com/OP-TEE/manifest/pull/321)

[OP-TEE/manifest#325: qemu_v8: Update TF-A to support Firmware Handoff](https://github.com/OP-TEE/manifest/pull/325)

To build and run on your local host:

```
repo init -u https://github.com/OP-TEE/manifest.git -m qemu_v8.xml
repo sync
cd build
make toolchains
make ARM_FIRMWARE_HANDOFF=y all
make ARM_FIRMWARE_HANDOFF=y run-only
```

After kernel lauches, run Xtest 1001 by:

```
xtest 1001
```

# Summary 

This work effectively transforms Measured Boot and Firmware Handoff from
“only works on my machine” features into continuously validated,
upstream-reliable, cross-project consistent. It ensures that any U-Boot
/ OP-TEE changes won’t invalidate Firmware Handoff / Measured Boot
functionalities.
