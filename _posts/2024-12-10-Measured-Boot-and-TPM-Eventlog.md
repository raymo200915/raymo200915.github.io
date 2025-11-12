---
layout: post
title: "Measured Boot and Event Log across TF-A / OP-TEE / U-Boot / Linux"
---
# Overview

Modern secure boot chains need not only verify the authenticity of
firmware components, but also record what was actually executed. Even
when signature verification is used (Verified Boot), there are still
cases where the system owner or a remote attestation server needs to
confirm the entire boot state. This is where Measured Boot and Event
Logging become essential.

This article explains how Measured Boot, Event Logs, and PCR banks
work, and how the Event Logs and PCR measurements propagate across the
boot chain TF-A / OP-TEE / U-Boot / Linux.

# What is Measured Boot

Measured Boot records what was loaded and executed during boot, instead
of merely enforcing verification. Every boot component is measured
(hashed), and the hash is:

  - Extended into TPM PCR registers, and

  - Logged in a human-readable Event Log stored in memory.

This allows the system itself or a remote verifier to determine whether
the platform booted into an expected and trusted state.

# PCRs and PCR Banks 

A TPM contains multiple Platform Configuration Registers which are
defined by TCG PC Client Profile 2.0.

| PCR  | Purpose                                      |
| ---- | -------------------------------------------- |
| PCR0 | CRTM / system firmware root of trust         |
| PCR1 | Boot configuration / UEFI variables          |
| PCR2 | Option ROMs / Video FW                       |
| PCR3 | Boot Device Drivers                          |
| PCR4 | Bootloader / Boot manager behavior           |
| PCR5 | Boot media layout / ExitBootServices         |
| PCR6 | State Transition                             |
| PCR7 | Secure boot key & policy state               |
| …    | Additional PCRs for kernel & OS measurements |

PCR index tells which part of the boot process the measurement belongs
to.

Each PCR may be implemented in multiple hash algorithms.

| Bank | Algorithm | Digest Size | Note                 |
| ---- | --------- | ----------- | -------------------- |
| 0    | SHA1      | 20          | legacy compatibility |
| 1    | SHA256    | 32          | modern default       |
| 2    | SHA384    | 48          | high assurance       |
| 3    | SHA512    | 64          | extended security    |

So, the TPM stores PCR values as a matrix:

|      | SHA1 | SHA256 | SHA384 | SHA512 | … |
| ---- | ---- | ------ | ------ | ------ | - |
| PCR0 | val  | val    | val    | val    |   |
| PCR1 | val  | val    | val    | val    |   |
| PCR2 | val  | val    | val    | val    |   |
| PCR3 | val  | val    | val    | val    |   |
| …    |      |        |        |        |   |

Any PCR bank can be represented via `PCR[N].<alg>`, for example:

```
PCR[1].sha1
PCR[4].sha256
PCR[5].sha384
PCR[7].sha512
```

PCR index tells what is measured, while PCR bank represents which
algorithm is used to measure.

# TCG2 Event Log

While PCRs store only accumulated hash digests, the Event Log contains
structured records describing:

  - What component was measured

  - What type of event it was

  - What digest was used

  - Optional metadata (e.g., image filename or GPT layout)

Linux will later relay the log via `linux,sml-base` and
`linux,sml-size`, then replay it and confirm that the resulting PCR
values match what the TPM reports.

Event Log transmission across the boot chain:

| Stage           | What Happens                                               |
| --------------- | ---------------------------------------------------------- |
| TF-A (BL2/BL31) | Measures firmware images and constructs initial Event Log. |
| OP-TEE (BL32)   | Receives log pointer and passes it onward.                 |
| U-Boot (BL33)   | Extends PCR values and appends new Event Log entries.      |
| Linux kernel    | Reads Event Log and PCR, exposes via /sys or TPM device.   |

# Measured Boot Flows

- Route A

  Measured Boot uses fTPM inside OP-TEE (ms-tpm-20-ref):

  TF-A (eventlog in memory, no PCR extend)→ OP-TEE (PCR extend via fTPM
  PTA service) → U-Boot (hand over the eventlog) → Linux

  This design avoids exposing TPM to normal world but is more complex and
  platform-dependent.

- Route B

  Measured Boot uses real TPM (hardware TPM / SPI TPM / TPM2-MMIO /
  SWTPM):

  TF-A (eventlog in memory, no PCR extend) → OP-TEE (hand over the
  eventlog) → U-Boot (PCR extend via TCG/TPM driver) → Linux

  - TF-A generates the Event Log but does not talk to TPM (No PCR
    extend).

  - U-Boot performs PCR extend using the TPM driver.

  Below are the steps of this route in details:

  1. TF-A generates Event Log (`qemu_measured_boot.c` in TF-A).

      - Computes measurements for BL31 / BL32 / BL33.

      - Writes the TCG Event Log structure into memory.

      - Passes pointer via device tree or Firmware Handoff (if enabled).

  2. OP-TEE hand over the Event Log via device tree or Firmware Handoff
    (if enabled).

  3. U-Boot consumes Event Log and extends PCR.

      When U-Boot enables `CONFIG_TPM_V2`, `CONFIG_TCG2`,
      `CONFIG_MEASURED_BOOT`, it does:

      - Initialize TPM (e.g., `virtio-tpm`, `tpm2-tis`, `tpm2-mmio`).

      - Import Event Log from TF-A and append new entries (kernel,
      initramfs, DTB).

      - Call `TPM2_PCR_Extend()` for each measured event respectively.

      Below are the PCR being extended and the events associated with:

      ```
      PCR[0] - EV_S_CRTM_VERSION
      PCR[1] - EV_EFI_HANDOFF_TABLES2
      PCR[1] - EV_EFI_VARIABLE_BOOT2
      PCR[1] or PCR[7] - EV_EFI_VARIABLE_DRIVER_CONFIG
      PCR[4] - EV_EFI_ACTION (EFI_CALLING_EFI_APPLICATION)
      PCR[4] - EV_EFI_ACTION (EFI_RETURNING_FROM_EFI_APPLICATION)
      PCR[5] - EV_EFI_GPT_EVENT
      PCR[5] - EV_EFI_ACTION (EFI_EXIT_BOOT_SERVICES_INVOCATION)
      PCR[5] - EV_EFI_ACTION (EFI_EXIT_BOOT_SERVICES_SUCCEEDED)
      PCR[5] - EV_EFI_ACTION (EFI_EXIT_BOOT_SERVICES_INVOCATION)
      PCR[5] - EV_EFI_ACTION (EFI_EXIT_BOOT_SERVICES_FAILED)
      PCR[0] ~ PCR[7] - EV_SEPARATOR
      ```

      - Expose Event Log to Linux via `linux,sml-base` and `linux,sml-size`.

      At this point, `PCR[N]` values are finalized before Linux boots.

  4. Linux reads Event Log.

      Linux exposes the Event Log to:

      ```
      /sys/kernel/security/tpm0/binary_bios_measurements
      /sys/kernel/security/tpm0/ascii_bios_measurements
      ```

      A verifier can detect tampering via replaying Event Log, recomputing
      and comparing.

  Please reference on my blog "[Solve the Measured Boot Pitfall: PCR Bank Misconfiguration in Run-time](https://raymo200915.github.io/2025/02/01/Measured-Boot-Pitfall-PCR-Bank-Misconfiguration.html)" for a full "Route B" journey.
