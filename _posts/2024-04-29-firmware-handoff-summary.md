---
layout: post
title: "Summary of Firmware Handoff Implementation across TF-A / OP-TEE / U-Boot"
---
# Overview

Modern embedded platforms often use multiple boot stages during system startup - for example, Trusted Firmware-A, OP-TEE in the secure world, and U-Boot or other bootloaders in the normal world. These components frequently need to exchange configuration data, memory layout information, firmware metadata, or platform-specific runtime context. Historically, this information exchange has been implemented in ad-hoc, vendor-specific ways, resulting in fragile integration, poor portability, and maintenance challenges across diverse hardware platforms.

To address this, Firmware Handoff Specification is introduced, which standardizes how information is passed across bootloader stages. The key concept of the specification is the Transfer List (TL): a contiguous data structure residing in memory that holds one or more Transfer Entries (TEs). Each entry describes a specific piece of information that one boot stage exports for consumption by later stages.

I published an article about the implementation of Firmware Handoff on Linaro Blog:

[Passing information across bootloader components, Linaro Blog (April 29, 2024), Author: Raymond Mao](https://www.linaro.org/blog/passing-information-across-bootloader-components/).

# Key Concepts

Transfer List (TL): A header plus a sequence of variable-length Transfer Entries stored in memory.

Transfer Entry (TE): A structured item identified by a unique type ID, containing metadata and the data payload.

Extensibility: The specification defines a standard set of TE types but allows for vendor- or platform-specific extensions without breaking compatibility.

# Adoption Across Firmware Components

Integration of multiple open-source firmware projects:

- TF-A: TL generation and handoff introduced since v2.10 and with full features since v2.13.0;

- OP-TEE: TL parsing and memory management support since v4.1.0 and with full features since v4.7.0;

- U-Boot: Support implemented by mapping TL into U-Boot’s bloblist infrastructure since v2024.01 and all features ready since v2025.04.

Enabling the flow typically involves:

- Building TF-A with Transfer List library enabled and the appropriate Secure Payload Dispatcher.

- Ensuring OP-TEE exports necessary TE contents back to TF-A and onward.

- Configuring U-Boot with Bloblist selected and defining memory placement for the TL.

# Example Workflow

A typical startup sequence might look like this:

- BL2 creates the TL and inserts an entry containing the system’s Device Tree Blob.

- BL31 validates and augments the TL (e.g., OP-TEE memory layout).

- OP-TEE consumes and updates entries (e.g., reserved-memory regions), then returns control.

- BL31 copies the TL to non-secure memory.

- U-Boot imports the TL into its bloblist and uses it to configure its runtime environment.

# Why This Matters

This common handoff format:

- Reduces reliance on platform-specific boot integration code

- Improves maintainability across different SoCs and boards

- Avoids misusing the Device Tree as a general-purpose message-passing structure

- Enables more predictable and repeatable boot flows in both secure and non-secure environments

# Quick Build and Demo

Get the makefile for building from my Github project:
https://github.com/raymo200915/firmware_handoff_build_with_measured_boot

```
$ git clone git@github.com:raymo200915/firmware_handoff_build_with_measured_boot.git
```

Follow README (use case A) for build and run instructions.
It fetches all necessary components across TF-A / OP-TEE / U-Boot, builds and runs with Firmware Handoff enabled.

# All Patches enabled Firmware Handoff across boot components

Contributions to the specification:

- [FirmwareHandoff/firmware_handoff#19: add standard TEs for OPTEE](https://github.com/FirmwareHandoff/firmware_handoff/pull/19)

- [FirmwareHandoff/firmware_handoff#74: Add Transfer Entry for Devicetree Overlay](https://github.com/FirmwareHandoff/firmware_handoff/pull/74)

TF-A:

- Introduce Transfer List library, Device Tree and OP-TEE pageable part handoff, QEMU platform code and enablement in BL2 / BL31:

  - [22178: feat(qemu): implement firmware handoff on qemu](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/22178)

  - [22215: feat(handoff): introduce firmware handoff library](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/22215)

  - [22581: build(qemu): add transfer list build](https://review.trustedfirmware.org/c/ci/tf-a-ci-scripts/+/22581)

  - [23776: feat(handoff): enhance transfer list library](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/23776)

  - [23777: feat(optee): enable transfer list in opteed](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/23777)

  - [23778: feat(qemu): enable transfer list to BL31/32](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/23778)

- Extension for TPM Event Log handoff:

  - [33546: feat(handoff): common API for TPM event log handoff](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/33546)

  - [34143: feat(handoff): transfer entry ID for TPM event log](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/34143)

  - [34144: feat(qemu): hand off TPM event log via TL](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/34144)

- Enhancements and bug-fix:

  - [33545: fix(handoff): fix register convention in opteed](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/33545)

  - [34142: fix(qemu): fix register convention in BL31 for qemu](https://review.trustedfirmware.org/c/TF-A/trusted-firmware-a/+/34142)

  - [41152: fix: TE start and end address alignments](https://review.trustedfirmware.org/c/shared/transfer-list-library/+/41152)

OP-TEE:

- Introduce Transfer List library, memory layout update, Device Tree and OP-TEE pageable part handoff in OP-TEE OS:

  - [OP-TEE/optee_os#6308: Firmware handoff](https://github.com/OP-TEE/optee_os/pull/6308)

  - [OP-TEE/optee_os#6510: Update transfer list to align to the spec](https://github.com/OP-TEE/optee_os/pull/6510)

- Enhancements and bug-fix:

  - [OP-TEE/optee_os#6461: core: fixup of transfer list entry overriding](https://github.com/OP-TEE/optee_os/pull/6461)

  - [OP-TEE/optee_os#6548: core: fixup of transfer list header size](https://github.com/OP-TEE/optee_os/pull/6548)

  - [OP-TEE/optee_os#7229: core: fix potential panic when setting transfer entry size](https://github.com/OP-TEE/optee_os/pull/7229)

  - [OP-TEE/optee_os#7230: core: expand the fdt transfer entry right before it is being used](https://github.com/OP-TEE/optee_os/pull/7230)

  - [OP-TEE/optee_os#7483: core: kernel: align the address of transfer entry](https://github.com/OP-TEE/optee_os/pull/7483)

U-Boot:

- Adapt bloblist to Firmware Handoff specification:

  - [\[PATCH v5 00/11\] Support Firmware Handoff spec via bloblist](https://lore.kernel.org/u-boot/20231229174244.892818-1-raymond.mao@linaro.org/)

- Basic handoff flow from previous boot stage, Device Tree handoff:

  - [\[PATCH v8 0/8\] Handoff bloblist from previous boot stage](https://lore.kernel.org/u-boot/20240203163631.177508-1-raymond.mao@linaro.org/)

  - [\[PATCH v2 2/2\] env: point fdt address to the fdt in a bloblist](https://lore.kernel.org/u-boot/20250331224011.2734284-2-raymond.mao@linaro.org/)

- Extension for TPM Event Log handoff:

  - [\[PATCH v7 2/3\] tcg2: decouple eventlog size from efi](https://lore.kernel.org/u-boot/20250127144941.645544-2-raymond.mao@linaro.org/)

  - [\[PATCH v7 3/3\] tpm: get tpm event log from bloblist](https://lore.kernel.org/u-boot/20250127144941.645544-3-raymond.mao@linaro.org/)

- Extension for Device Tree Overlay handoff (upstreaming in progress):

  - [\[PATCH v3 0/6\] Add support for DT overlays handoff](https://lore.kernel.org/u-boot/20250718141621.3147633-1-raymond.mao@linaro.org/)

- Enhancements and bug-fix:

  - [\[PATCH v7 1/3\] bloblist: add api to get blob with size](https://lore.kernel.org/u-boot/20250127144941.645544-1-raymond.mao@linaro.org/)

  - [\[PATCH v2 1/2\] bloblist: fix the overriding of fdt from bloblist](https://lore.kernel.org/u-boot/20250331224011.2734284-1-raymond.mao@linaro.org/)

  - [\[PATCH v2 1/2\] bloblist: refactor xferlist and bloblist](https://lore.kernel.org/u-boot/20250220000223.1044376-1-raymond.mao@linaro.org/)

  - [\[PATCH v2 2/2\] bloblist: kconfig for mandatory incoming standard passage](https://lore.kernel.org/u-boot/20250220000223.1044376-2-raymond.mao@linaro.org/)
