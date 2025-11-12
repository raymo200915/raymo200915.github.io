---
layout: post
title: "Solve the Measured Boot Pitfall: PCR Bank Misconfiguration in Run-time"
---
# Overview

In a TPM 2.0 environment, each PCR index exists in multiple parallel PCR
banks, one per hash algorithm:

| Bank | Algorithm | Digest Size | Note                 |
| ---- | --------- | ----------- | -------------------- |
| 0    | SHA1      | 20          | legacy compatibility |
| 1    | SHA256    | 32          | modern default       |
| 2    | SHA384    | 48          | high assurance       |
| 3    | SHA512    | 64          | extended security    |

A single PCR index “N” therefore looks conceptually like
`PCR[N].<alg>`:

```
PCR[N].sha1
PCR[N].sha256
PCR[N].sha384
PCR[N].sha512
```

Each bank is extended independently.

This dual-axis model is exactly where configuration mistakes occur.

This post is going to analyze why the misconfiguration happens by using
SWTPM as an example and introduce my solution in the upstream.

# Where the Misconfiguration Comes From

Different components determine which hash algorithm(s) to use by their
own way.

| Component | Determines by        | Determines when       | Default                                         |
| --------- | -------------------- | --------------------- | ----------------------------------------------- |
| TF-A      | `MBOOT_EL_HASH_ALG`  | compile-time option   | Typically SHA256 only                           |
| U-Boot    | `CONFIG_SHAxxx`      | compile-time kconfig  | Can enable multiple banks.                      |
| SWTPM     | `--pcr-banks`        | runtime configuration | All banks enabled by default without arguments. |

So, see an example of real-world situation:

- TF-A: Logs only SHA256 digests in Event Log by `MBOOT_EL_HASH_ALG=sha256`

- U-Boot: Select SHA1 and SHA256 via kconfig

- SWTPM: Enable SHA1 and SHA256 by `--pcr-banks=sha1,sha256`

This mismatch is subtle and easy to overlook.

# Why This Causes a Problem 

The Event Log initialized with only one digest per event (measurement of EL3 firmware / OP-TEE parts) - the digest TF-A
generated (SHA256 in our case).

```
...
- EventNum: 2
  PCRIndex: 0
  EventType: EV_POST_CODE
  DigestCount: 1
  Digests:
  - AlgorithmId: sha256
    Digest: "e4f7a3566cf36c9ed38823f407a279b7f9d1e034fa672232f449914d036fefa4"
  EventSize: 14
  Event: |-
    SECURE_RT_EL3
- EventNum: 3
  PCRIndex: 0
  EventType: EV_POST_CODE
  DigestCount: 1
  Digests:
  - AlgorithmId: sha256
    Digest: "61addc1b8436aaeb58fa75d3bf8ae09ad6b91c305c8416cce40f6061ddbda2cd"
  EventSize: 20
  Event: |-
    SECURE_RT_EL1_OPTEE
- EventNum: 4
  PCRIndex: 0
  EventType: EV_POST_CODE
  DigestCount: 1
  Digests:
  - AlgorithmId: sha256
    Digest: "864086492c2f52c81a8dfb6036db1950834b87b93c0c3849f1aca492de265638"
  EventSize: 27
  Event: |-
    SECURE_RT_EL1_OPTEE_EXTRA1
- EventNum: 5
  PCRIndex: 0
  EventType: EV_POST_CODE
  DigestCount: 1
  Digests:
  - AlgorithmId: sha256
    Digest: "538fb3ce3e70482202d98eb9602e9cb762278ab0aeece651d88894ab5faf094f"
  EventSize: 6
  Event: |-
    BL_33
...
```

But later U-Boot will measure other components (e.g., kernel, EFIvar, EFIBoot) with both SHA1 and SHA256.

```
...
- EventNum: 8
  PCRIndex: 7
  EventType: EV_EFI_VARIABLE_DRIVER_CONFIG
  DigestCount: 2
  Digests:
  - AlgorithmId: sha1
    Digest: "85d64b3c1d4eb49f591158589311f426ab186e83"
  - AlgorithmId: sha256
    Digest: "b70b7c1b92209af66d79d12dec1f14f4b8c71c0c69be22a1a04f5c5804e26ec3"
  EventSize: 51
  Event:
    VariableName: 8be4df61-93ca-11d2-aa0d-00e098032b8c
    UnicodeNameLength: 9
    VariableDataLength: 1
    UnicodeName: AuditMode
    VariableData: "00"
- EventNum: 9
  PCRIndex: 4
  EventType: EV_EFI_BOOT_SERVICES_APPLICATION
  DigestCount: 2
  Digests:
  - AlgorithmId: sha1
    Digest: "3d7770341cef967f51006670d70b6b0262dec248"
  - AlgorithmId: sha256
    Digest: "eec05efb0afb7a32969295e1388119055423cd8bc6ace145f554340556634bfb"
  EventSize: 130
  Event:
    ImageLocationInMemory: 0x13d549000
    ImageLengthInMemory: 856064
    ImageLinkTimeAddress: 0x0
    LengthOfDevicePath: 98
    DevicePath: '04012a0001000000000800000000000000001000000000001056aebd31334d4e9466acb5caf0b4a60202040434004500460049005c00640065006200690061006e005c007300680069006d0061006100360034002e0065006600690000007fff0400'
...
```

Further U-Boot extends both SHA1 / SHA256 PCR banks:

```
PCR[N].sha1 <- extend(digest_sha1)
PCR[N].sha256 <- extend(digest_sha256)
```

Obviously, early-stage measurements done by TF-A lack SHA1 records. As a result, those measurements are never extended to the corresponding PCR SHA1 bank (`PCR[0].sha1` in our example)

So, when using tpm2_eventlog_validate tool to replay and verify the Event Log (`Replay(event_log, PCR_index, hash_bank)`):

| Replay Operation              | Expected PCR value | Verification Result | PCR Index Range |
| ----------------------------- | ------------------ | ------------------- | --------------- |
| Replay(event_log, N, SHA256)  | PCR[N].sha256      | ✅ matches          | N = [0..14]     |
| Replay(event_log, 0, SHA1)    | PCR[0].sha1        | ❌ mismatch         |                 |
| Replay(event_log, M, SHA1)    | PCR[M].sha1        | ✅ matches          | M = [1..14]     |

It prompts errors like:

```
WARN: Event #2 (PCR[0]) missing digest for SHA1 bank
ERROR: Replay of SHA1 bank for PCR[0] failed: expected 000000… but actual f3ab4f…
```

For an attestation tool, inconsistent PCR values across banks means:

Measured Boot becomes untrustworthy.

And depending on configuration, this leads to different breakages.

# Observed Consequences

PCR bank misconfigurations cause impacts not limited to:

| Layer                                                                    | Symptom                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| `tpm2_pcrread`, `/sys/class/tpm/.../pcrs`                                | PCR banks disagree / unexpected values appear     |
| `tpm2_eventlog` replay                                                   | “PCR mismatch” errors                             |
| SystemReady-ES / BBSR certification                                      | Fails on firmware integrity verification          |
| Remote attestation services (Keylime / Verifier / Intel Trust Authority) | Node is rejected as "Integrity compromised"       |
| IMA appraisal with policy binding to PCR 0/4/7                           | Filesystem validation fails, causing boot failure |

So even though “everything boots fine”, the platform becomes
unattestable, which defeats the point of Measured Boot.

# Root Cause Summary and How to Fix It

A measured boot system is only valid if all firmware stages and the TPM device
agree on the active PCR bank set.

The solution to fix it is to develop a logic to:

  - detect the hash algorithms from among the current Event Log, SWTPM
    active PCR banks and the ones supported by firmware in run-time;

  - if any misconfigurations exist, determine the new PCR banks
    configuration we need (a subset of PCR banks which all components
    can agree on);

  - send PCR Allocate command followed by a TPM Shutdown command to
    reconfigure the new PCR active banks and reset the system;

  - in the next power cycle, the system will run with the new PCR active
    banks without any algorithm mismatches.

# Patches Links

I’ve developed two U-Boot patch series to address this issue by two steps.

The first series is to report potential PCR banks misconfiguration and
exit tpm_tcg2 with errors logged.

[Tpm exit with error when algorithm dismatches \[v2\]](https://patchwork.ozlabs.org/project/uboot/list/?series=438118&state=%2A&archive=both&state=*)

It includes refactoring to simplify the logics in tpm and tpm_tcg2 and
logic to report errors when:

  - an Event Log is handed over from the previous boot stage but TPM
    device was configured with an algorithm that does not exist in the
    Event Log;

  - TPM device was configured with an algorithm that is not supported by
    U-Boot;

  - failures observed when parsing the Event Log.

The second series is to implement PCR Allocate command to handle the PCR
misconfiguration among TPM device, Event Log from previous boot stage
and what U-Boot supports.

[Reconfigure TPM when active hash algorithms dismatch \[v3\]](https://patchwork.ozlabs.org/project/uboot/list/?series=441921&archive=both&state=*)

It re-configures TPM device if any active PCR banks are not supported by
U-Boot, or does not exist in the Event Log passed in.

  - Determine the new PCR banks configuration (a subset of PCR banks which all components
    can agree on).
  - A PCR Allocate command will be sent with the determined PCR banks configurations, followed by a TPM shutdown command and a hardware reset to activate those new configurations.
  - If any of the algorithms from the Event Log is not supported by U-Boot, or TPM device does not support all U-Boot algorithms, exit with error.
  - This feature can be enabled / disable via kconfig `TPM_PCR_ALLOCATE`.

# Test Instructions

Follow below instructions to test all patches on QEMU with SWTPM on a
Debian distro image (in qcow2 format, and the kernel should be built with `CONFIG_TCG_TIS` to support TPM driver).

Get the makefile for building from my Github project:
https://github.com/raymo200915/firmware_handoff_build_with_measured_boot

```
$ git clone git@github.com:raymo200915/firmware_handoff_build_with_measured_boot.git
```

Rename your distro image file to “debian.qcow2” and place it into the project’s root directory.

Follow README (use case B or C) for build and run instructions.

When launch U-Boot, below logs prompt:

```
TCG_EfiSpecIDEvent:
PCRIndex : 0
EventType : 3
Digest : 00
: 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
: 00 00 00
EventSize : 33
Signature : Spec ID Event03
PlatformClass : 0
SpecVersion : 2.0.2
UintnSize : 1
NumberOfAlgorithms : 1
DigestSizes :
#0 AlgorithmId : SHA256
DigestSize : 32
VendorInfoSize : 0
PCR_Event2:
PCRIndex : 0
EventType : 3
Digests Count : 1
#0 AlgorithmId : SHA256
Digest : 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
       : 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
EventSize : 17
Signature : StartupLocality
StartupLocality : 0
PCR_Event2:
PCRIndex : 0
EventType : 1
Digests Count : 1
#0 AlgorithmId : SHA256
Digest : de 4f d1 f3 0c a9 78 47 3f 90 7b d0 a9 da d6 31
       : f0 62 e8 23 22 7d 82 3e 5f df 2f 6b 6d e5 90 69
EventSize : 14
Event : SECURE_RT_EL3
PCR_Event2:
PCRIndex : 0
EventType : 1
Digests Count : 1
#0 AlgorithmId : SHA256
Digest : 8c f0 5c 18 da 06 32 ba 88 6c 98 32 c6 e4 75 5a
       : ad 16 42 58 e0 8a 3b 94 c0 50 31 af 2a 34 38 a4
EventSize : 6
Event : BL_33
```

This is the initial Event Log generated by TF-A.
Debian image should be loaded automatically by Boot Manager, if not, set the `BootOrder`
in U-Boot console, and run Boot Manager manually:

```
=>eficonfig

Description: debian
File: virtio 0:1/EFI\debian\shimaa64.efi
Initrd File:
Fdt File:
Optional Data:
Save
Quit

=>booteif bootmgr
```

When SWTPM is configured with more than SHA256, for example, by `export
PCR_BANKS=sha1,sha256,sha384,sha512`.

Below logs indicate PCR Allocate, TPM Shutdown and system reset happened
and SWTPM is reconfigured:

```
TPM active algorithm(s) not exist in eventlog  
sha1  
algo_mask: algo_mask  
set bank[0] sha1 off  
set bank[1] sha256 on  
set bank[2] sha384 off  
set bank[3] sha512 off  
PCR allocate done, shutdown TPM and reboot  
resetting ...
```

After launching kernel, use tpm2_eventlog to explore the Event Log:

```
sudo apt install tpm2-tools
sudo tpm2_eventlog /sys/kernel/security/tpm0/binary_bios_measurements
```

## Debug Tips

If tpm2_eventlog prompts errors, first check if the Event Log
passed from U-Boot correctly. Log should prompt with dmesg:

```
[ 0.000000] efi: EFI v2.100 by Das U-Boot

[ 0.000000] efi: TPMFinalLog=0x13d622040 RTPROP=0x13d620040 SMBIOS
3.0=0x13e696000 MOKvar=0x13d606000 TPMEventLog=0x13d5f1040
RNG=0x13d5f0040 MEMRESERVE=0x13d5ef040
```

If not, search for the TPM related log to make sure TPM is working:

```
dmesg | grep -i tpm
```

Below log exists if the kernel does not enable `CONFIG_TCG_TIS`:

```
[ 0.000000] efi: TPMFinalLog=0x13d622040 RTPROP=0x13d620040 SMBIOS
3.0=0x13e696000 MOKvar=0x13d606000 TPMEventLog=0x13d5f1040
RNG=0x13d5f0040 MEMRESERVE=0x13d5ef040

[ 4.901756] ima: No TPM chip found, activating TPM-bypass!
```

Double check the kconfig to make sure `CONFIG_TCG_TIS` is selected:

```
zgrep CONFIG_TCG_TIS /proc/config.gz
```

Or:

```
grep CONFIG_TCG_TIS /boot/config-$(uname -r)
```

If `CONFIG_TCG_TIS` is disabled, you have to rebuild and install the
kernel via below steps:

  - Get the kernel version:

    ```
    uname -r
    ```

  - Get the kernel source code by the version.

  - Enable `CONFIG_TCG_TIS` via menuconfig:

    ```
    cp /boot/config-$(uname -r) .config
    make menuconfig
    -> Device Drivers
      -> Character devices
        -> TPM Hardware Support (TCG_TPM [=y])
          -> TPM Interface Specification 1.2 Interface / TPM 2.0 FIFO Interface
    ```

  - Rebuild and install:

    ```
    make clean
    make -j$(nproc)
    sudo make modules_install
    sudo make install
    ```
