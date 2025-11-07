---
layout: post
title: "TPM 2.0 Event Log for U-Boot SPL on an ARMv8 Measured Boot Chain"
---
# Overview

This report focuses on enabling TPM 2.0 event log support in U-Boot SPL
(BL2). In particular, the goal is for SPL to measure all subsequent
images (BL31, BL32, BL33), format a proper TPM event log for those
measurements, and pass the log to the next stage (BL31) so that
ultimately U-Boot proper (BL33) and the OS (Linux) can access it.

# Existing infrastructure in U-Boot SPL

Until recently, the measured boot logic (event log creation, etc.) in
U-Boot was tied to UEFI (TCG2) subsystem in U-Boot proper. The SPL has
no built-in knowledge of passing logs upward, nor can it perform any
measurements. That said, U-Boot does provide configuration options to
enable TPM support in SPL if desired.

For example, `CONFIG_SPL_TPM=y` (with `CONFIG_TPM_V2`) will include the
TPM 2.0 library in SPL, and `CONFIG_SPL_SHA256=y` can be set so SPL has
hashing functions. These Kconfig options should allow TPM usage in SPL
on platforms that can afford the space​. Driver Model (DM) support in
SPL (`CONFIG_SPL_DM=y`) is also required to use TPM drivers. In
practice, no existing platforms in U-Boot mainline enable this due to
size and complexity, but it’s technically possible.

## TPM Event Logging Support

Mainline U-Boot’s measured boot support is primarily implemented in
U-Boot proper (BL33), not in the SPL stage by default. Recent U-Boot
versions include a generic measured boot framework implemented by Linaro
that can log events and extend PCRs during OS boot. For example,
U-Boot’s EFI TCG2 protocol and legacy boot measurement code can
measure Linux images, initramfs, device trees, etc., and replay event
logs from the previous boot stage, using a TPM 2.0 device​. There is
also support to append events to a log in memory, which the kernel can
later retrieve. However, in the default configuration, U-Boot SPL does
not perform measured boot of the later stages.

The reason for this is code size constraints. U-Boot SPL is aimed to be
a minimal loader (often limited to 64 KB or similar, especially on
resource-constrained platforms). Including a TPM driver, bus drivers,
hashing libraries (SHA256), and event log formatting code in SPL can be
heavy. As a result, the first measurements are only performed in U-Boot
proper instead of SPL​. When TF-A is used instead of SPL, it exports an
EventLog that U-Boot can later replay in the hardware.

## TPM Device Drivers

U-Boot SPL would need to initialize and communicate with a TPM device
through TPM 2.0 drivers.

  - SPI TPMs: Currently available for U-Boot proper
  (`CONFIG_TPM2_TIS_SPI`) but not for SPL, a new Kconfig
  (`CONFIG_SPL_TPM2_TIS_SPI`) and code modifications are needed
  for inclusion in SPL (`CONFIG_SPL_DM_SPI=y` is required as a
  dependency).

  - I²C TPMs: Similarly, currently available for U-Boot proper
  (`CONFIG_TPM2_TIS_I2C`) but not for SPL, a new Kconfig
  (`CONFIG_SPL_TPM2_TIS_I2C`) is needed for inclusion in SPL
  (`CONFIG_SPL_DM_I2C=y` is required as a dependency).

  - Google’s Cr50 TPM (on I2C): There is an existing Kconfig
  `CONFIG_SPL_TPM2_CR50_I2C` to include into SPL, but that implies
  development has to be on a platform with a Cr50 module and please
  note that CR50 is an legacy hardware from Google and not fully
  compatible with TPM 2.0.

  - TPM TIS over MMIO: U-Boot proper has a Kconfig `CONFIG_TPM2_MMIO`
  allows emulating a TPM 2.0 device via swtpm through memory-mapped
  TIS interface for QEMU platforms while `CONFIG_SPL_TPM2_MMIO` is
  missing for SPL. On top of that the support of SPL on QEMU is
  missing for Arm architecture.

## Firmware Handoff Support

Base on my implementation of Firmware Handoff specification across TF-A,
OP-TEE and U-Boot, TPM event log is handed over via Transfer List
through TF-A BL2, opteed, OP-TEE, U-Boot and finally pass to kernel via
a DT entry `linux,sml-base` and `linux,sml-size`. So, the handoff of
TPM event log via the path from BL31 (opteed) to Linux is ready,
the only question is in SPL.

Although Firmware Handoff in U-Boot proper is implemented on top of
bloblist, which can be enabled in SPL via `CONFIG_SPL_BLOBLIST=y`,
Firmware Handoff itself is not yet implemented/tested in SPL. There are
Kconfigs like `CONFIG_HANDOFF` or `CONFIG_SPL_HANDOFF` for similar
purposes using bloblist to hand over information from SPL to U-Boot
proper, but those are legacy and not compliant with Firmware Handoff
specification.

To get a full working handoff path for TPM event log, similar
implementations in TF-A BL2 needs to be integrated into SPL for
initializing a bloblist and creating entries for FDT
(`BLOBLISTT_CONTROL_FDT`) and TPM event log (`BLOBLISTT_TPM_EVLOG`) and
then handing it over to the next boot stage following the register
conventions defined in Firmware Handoff specification.

## Summary

Mainline U-Boot SPL does not perform any measurements of BL31/BL32/BL33,
but the building blocks for enabling the hardware (TPM driver, hash
libraries and bus drivers) are available behind Kconfig options.

The measured boot specific config options are missing in SPL (e.g.
`CONFIG_MEASURED_BOOT` or `EFI_TCG2_PROTOCOL`). The task is to leverage
the measured boot framework from U-Boot proper into the SPL context.
Enabling them will bloat SPL, so it must be done carefully.

Bottom-line SPL Kconfigs:

| Name                                      | Purpose            | Status  |
| ----------------------------------------- | ------------------ | ------- |
| `CONFIG_SPL_TPM`                          | TPM Library        | Exists  |
| `CONFIG_SPL_DM`                           | Driver Model       | Exists  |
| `CONFIG_SPL_CRC8`                         | CRC8               | Exists  |
| `CONFIG_SPL_SHA256`                       | Hash Algorithm     | Exists  |
| `CONFIG_SPL_LEGACY_HASHING_AND_CRYPTO`    | Hash Library       | Exists  |
| `CONFIG_SPL_MBEDTLS_LIB`                  | Hash Library       | Exists  |
| `CONFIG_SPL_TPM2_TIS_SPI`                 | TPM Driver (SPI)   | Missing |
| `CONFIG_SPL_DM_SPI`                       | Driver Model (SPI) | Exists  |
| `CONFIG_SPL_TPM2_TIS_I2C`                 | TPM Driver (I2C)   | Missing |
| `CONFIG_SPL_DM_I2C`                       | Driver Model (I2C) | Exists  |
| `CONFIG_SPL_TPM2_MMIO`                    | TPM Driver (MMIO)  | Missing |
| `CONFIG_SPL_MEASURED_BOOT`                | TPM TCG2 Library   | Missing |
| `CONFIG_SPL_BLOBLIST`                     | Bloblist Library   | Exists  |
| `CONFIG_SPL_OF_LIBFDT`                    | FDT Library        | Exists  |

# Code Size Impact and Mitigations

Enabling full TPM-measured boot in SPL will increase the SPL’s size
significantly. The components that add to SPL size include:

  - TPM driver code:

    To support measured boot, one of the TIS (TPM Interface Spec) drivers
    is required over SPI, I2C or MMIO
   
    Code to probe the device, send commands (like `TPM2_Startup`,
    `PCR_Extend`, etc.), and handle response parsing needs to be included.
    While not huge, it is additional code (\~a few KB). Also, the driver
    depends on a CRC8 calculation for bitfields (the TIS locality
    computation uses a CRC8 of the TPM device ID). U-Boot’s TPM stack
    includes CRC8 code and `CONFIG_SPL_TPM` will imply to include the CRC8
    algorithm in SPL via `CONFIG_SPL_CRC8`​.

  - Hash algorithms:

    To measure components, SPL needs a cryptographic hash. SHA256 is the
    baseline for TPM 2.0. In 2024, I integrated MbedTLS into U-Boot,
    thus now U-Boot has both legacy and MbedTLS implementations supporting
    SHA1/256/384/512. Selecting one of them will pull in the algorithm’s
    code (a couple of KB typically for each) into SPL. For example,
    selecting `CONFIG_SPL_SHA256` will pull in the legacy code (via
    `CONFIG_SPL_LEGACY_HASHING_AND_CRYPTO=y`) or MbedTLS code (via
    `CONFIG_SPL_MBEDTLS_LIB=y`). Also, any platform can use a hardware
    crypto accelerator to offload hashing if that is supported.

  - Event log formatting:

    U-Boot’s tpm_eventlog or tcg2 code that creates the Spec ID event and
    appends events might be reused. This code isn’t extremely large, but
    it includes some data tables for algorithm IDs, event header
    structures, and helper functions to add events. An alternative option
    is to implement a simpler routine in SPL that directly writes the
    needed bytes to the log buffer. For example, writing out the Spec ID
    event (which is mostly static content aside from the algorithm list)
    and then writing all events in a straightforward way. However, reusing
    U-Boot’s common code (by enabling `CONFIG_MEASURED_BOOT` in SPL) is
    preferable for consistency. Note that `CONFIG_MEASURED_BOOT` normally
    pulls in `lib/tpm_tcg2.c` for U-Boot proper​. For SPL, we need to
    manually enable it by adding `CONFIG_SPL_MEASURED_BOOT`, which can be
    used as a main switch for the platform vendors who want to have early
    measurements in SPL.

  - Handoff of event log:

    Bloblist support in SPL (`CONFIG_SPL_BLOBLIST=y`) increases the ROM
    size and additionally `CONFIG_SPL_OF_LIBFDT` is required for handoff
    the FDT. Implementations to initialize bloblist and create entries for
    FDT and event log and then hand it over to the next stage following
    the Firmware Handoff register conventions will also bloat the size of
    SPL.

  - Memory usage:

    In addition to the code, some RAM buffers are needed for the log
    (e.g., 1\~2 KB for a few events). That’s almost negligible compared to
    typical DRAM sizes and even relative to SPL’s stack or heap, thus
    memory is not a concern, but ROM size is.

On platforms where SPL is very constrained (e.g., 64KB total), adding
measured boot might not be feasible without stripping other features.

Mitigation options: If size is borderline, consider to:

  - Only include SHA256

    We need to decouple all algorithm Kconfigs from `CONFIG_MEASURED_BOOT`
    and leave them as selectable choices for the platform vendors.

  - Use tiny printf in SPL (`CONFIG_SPL_USE_TINY_PRINTF`) to save
    space.

    The measured boot or TPM code itself could be optimized or
    partially ifdef’d out, for example, those commands which are not
    required in SPL. The bottom line should be `TPM2_Startup` and
    `TPM2_PCR_Extend`. If we want to support re-configuring TPM hash
    algorithms on-the-fly `TPM2_PCR_Allocate` is required.

  - Trimming of other drivers from SPL as a trade-off.

# Development Platform Options

When choosing a development platform to experiment with TPM 2.0 in
U-Boot SPL, we look for a board that

(1) is ARMv8 and uses U-Boot SPL as part of its normal boot,

(2) has a TPM 2.0 module on-board or readily attachable, and

(3) is well-supported in mainline U-Boot.

A top candidate meeting these criteria is the NXP LS1046A Freeway board:

LS1046A Freeway (FRWY-LS1046A): This 64-bit Quad A72 board uses U-Boot
SPL to initialize DDR and load U-Boot. NXP offers a variant of it with
an onboard Infineon TPM 2.0. In fact, the board reference design “-TP”
version includes an Infineon SLB9670 TPM over SPI​. U-Boot supports SPI
and SPL on this board, and NXP’s firmware stack is known to integrate
TPM usage. This platform is actively used in the community.

Other notable platforms include:

QEMU arm64: Missing SPL support for Arm while risc-v support does exist.

NXP i.MX 8M EVK: While these evaluation boards don’t ship with a TPM by
default, they expose SPI/I2C buses where a TPM module can be attached.
They are ARMv8 (Cortex-A53) and use U-Boot SPL. The i.MX8M EVK can be
used similarly by wiring an SPI TPM. Both SPL and U-Boot support TPM
2.0.

Rockchip RK3399 boards (e.g. Pinebook Pro, Rock Pi 4): These boards use
U-Boot SPL for DDR init and often have available connectors for TPM. For
example, Rock Pi 4 has an optional header where an SPI TPM module can be
connected.

## To-Do List

<table>
<thead>
<tr class="header">
<th>Step</th>
<th>Description</th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td>Support SPL on QEMU (Optional)</td>
<td>Support SPL build in U-Boot for QEMU arm64 platform. This is optional for development on the QEMU arm64 platform.</td>
</tr>
<tr class="even">
<td>Config U-Boot proper/SPL for TPM and Measured Boot</td>
<td><p>In U-Boot config, add <code>CONFIG_SPL_MEASURED_BOOT</code>, decouple all hash algorithm Kconfigs from <code>CONFIG_$(XPL)_MEASURED_BOOT</code>.</p>
<p>Set <code>CONFIG_BLOBLIST</code>, <code>CONFIG_SPL_BLOBLIST</code>, <code>CONFIG_TPM=y</code>, <code>CONFIG_SPL_TPM=y</code>, <code>CONFIG_SHA256=y</code>, <code>CONFIG_SPL_SHA256=y</code>, <code>CONFIG_TPM_V2=y</code>, <code>CONFIG_TPM2_TIS_MMIO=y</code>, <code>CONFIG_MEASURED_BOOT=y</code>, <code>CONFIG_SPL_MEASURED_BOOT=y</code>. This ensures both U-Boot proper and SPL have the TPMv2 driver and hash algorithm with measured boot support (assuming MMIO driver is in-used)​.</p></td>
</tr>
<tr class="odd">
<td>Initialize TPM in SPL</td>
<td>In SPL, after initializing hardware, call <code>tpm_auto_startup()</code> or similar to send <code>TPM2_Startup</code>. Verify TPM is ready via return code.</td>
</tr>
<tr class="even">
<td>Measure BL31/BL32/BL33</td>
<td>For each loaded image: compute SHA256 using U-Boot’s legacy or MbedTLS hash API. Then call <code>tpm_extend(pcr=0, hash)</code> or send a TPM2 PCR extend command via the driver. Handle errors (<code>PCR_extend</code> should return a success code).</td>
</tr>
<tr class="odd">
<td>Construct Event Log</td>
<td>Reserve a chunk of DDR (either statically or via malloc) for the event log. Use U-Boot’s <code>tcg2_measurement_init()</code> and <code>tcg2_log_append()</code> to create the SpecID event and append each measurement event.</td>
</tr>
<tr class="even">
<td>Handoff to BL31</td>
<td>Initialize bloblist and create entries of <code>BLOBLISTT_CONTROL_FDT</code> and <code>BLOBLISTT_TPM_EVLOG</code> with FDT data and event log respectively.<br />
Pass the bloblist to BL31 via Firmware Handoff register conventions.</td>
</tr>
</tbody>
</table>
