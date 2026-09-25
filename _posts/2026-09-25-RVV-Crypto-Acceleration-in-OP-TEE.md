---
layout: post
title: "RISC-V: Add RVV Crypto Acceleration support in OP-TEE"
---
# Overview

This post describes my work to add RISC-V Vector Cryptography (RVV crypto)
acceleration to OP-TEE. It is now ready for upstream review at
[OP-TEE OS PR #7967](https://github.com/OP-TEE/optee_os/pull/7967).

OP-TEE already has the `crypto_drv` abstraction for replacing selected
software cryptographic primitives with hardware-assisted implementations. The
goal was to provide the required RISC-V implementation using the ratified RVV
1.0 vector-cryptographic instructions, while preserving OP-TEE's software
fallback and secure-world context-isolation rules.

## Deliverable

The complete integration implements the following `crypto_drv` entry
points with RVV crypto instructions:

  - AES key expansion for AES-128, AES-192, and AES-256
  - AES ECB encryption and decryption
  - AES CBC encryption and decryption
  - AES big-endian CTR encryption
  - AES XTS encryption and decryption
  - SHA-256 compression
  - SHA-512 compression

The code uses compile-time selection - Selecting an AES, SHA-256, or SHA-512
accelerator derives the required `Zvkng`, RVV, and OP-TEE vector context
configuration.

## Status

The upstream series in [PR #7967](https://github.com/OP-TEE/optee_os/pull/7967) contains
7 parts.

  - RVV ISA configuration
  - Safeguard against automatic vectorization of ordinary C code
  - AES key expansion support
  - AES-XTS support
  - SHA-256/SHA-512 compression support
  - AES ECB / CBC / CTR support
  - OP-TEE integration for vector configurations

It was validated on QEMU RISC-V virt with `-cpu rv64,zkr=on,v=true,zvkng=true,zvbb=true`.

# Background and Motivation

OP-TEE's `crypto_drv` layer is intentionally below the high-level cryptographic
APIs. LibTomCrypt continues to provide the generic cipher and hash framework,
but its performance-critical block and compression operations can dispatch to
architecture-specific acceleration. This is a good fit for RISC-V vector
crypto: the existing API owns mode handling and fallback behavior, while the
new driver supplies the machine-specific transforms.

# Design

## ISA Configuration

The accelerator is controlled by the existing per-algorithm configuration
selectors:

```text
CFG_CORE_CRYPTO_AES_ACCEL
CFG_CORE_CRYPTO_SHA256_ACCEL
CFG_CORE_CRYPTO_SHA512_ACCEL
```

Their dependency chain is:

```text
AES/SHA-2 acceleration
        -> CFG_RISCV_ZVKNG=y
        -> CFG_RISCV_VECTOR=y
        -> CFG_WITH_VFP=y
```

`Zvkng` provides the vector AES and SHA-2 instruction families used. The build
uses separate ISA strings: C remains scalar, while the crypto and vector
assembly is compiled with RVV enabled.

## Reusing Linux Vector Assembly

The low-level AES and SHA-2 transforms are imported from Linux v7.2. The
original filenames, SPDX identifiers, licensing, and upstream copyright
attribution are retained; only the linkage adaptation needed by OP-TEE is
made. This avoids reimplementing complicated vector-crypto assembly and keeps
the code close to a widely reviewed upstream source.

OP-TEE-owned glue supplies the adaptation layer between `crypto_drv` and those
transforms. The SHA glue independently selects SHA-256 and SHA-512 compression
with their corresponding OP-TEE configuration options.

## AES Key Layout and Modes

LibTomCrypt and the imported Linux routines do not use the same key-context
layout.
The RISC-V glue constructs a Linux-compatible `struct riscv_aes_key`:
the encryption schedule begins at offset 0, the decryption schedule at offset
240, and the original key length at offset 480.
The imported vector routines use the normal encryption round-key schedule for
both encryption and decryption, so the adapter makes that schedule available
in both required key buffers.

ECB, CBC, and CTR use this same adapted key context.
The ECB wrappers pass a block-aligned input directly to the vector encrypt or
decrypt transform.
The CBC wrappers additionally pass the caller's IV to the vector routine, which
performs the chaining operation and updates the IV for the next operation.
For `crypto_accel_aes_ctr_be_enc()`, the glue calls the imported vector CTR
transform with the API's big-endian counter block; the routine encrypts counter
blocks, XORs them with the input, and advances the counter state.
Together, these wrappers provide every block-mode entry point required by
OP-TEE's generic accelerated AES path.

AES-XTS uses two keys. The glue encrypts the raw tweak with the second key,
constructs compatible contexts for the two schedules, and then calls the
imported RVV implementation. `Zvbb` is also enabled in QEMU for the imported
XTS tweak-generation code.

# Validation

The OP-TEE OS was built with all accelerators enabled:

```console
    CFG_CORE_CRYPTO_AES_ACCEL=y
    CFG_CORE_CRYPTO_SHA256_ACCEL=y
    CFG_CORE_CRYPTO_SHA512_ACCEL=y
```

The build configuration confirmed that the three accelerator selectors and
their derived `CFG_RISCV_ZVKNG`, `CFG_RISCV_VECTOR`, and `CFG_WITH_VFP`
dependencies were enabled. Symbol and disassembly checks then verified that
the accelerated entry points were linked, AES objects contained `vaes*`
instructions, and SHA objects contained `vsha2*` instructions. QEMU was
started with:

```console
-cpu rv64,zkr=on,v=true,zvkng=true,zvbb=true
```

The work is now available for validation under [RISE Secure SW Gitlab project](
https://gitlab.com/riseproject/riscv-optee)

Please follow the instructions below for testing:

```console
# Fetch buildroot code
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b rp022-m4

$ cd buildroot
# Build the default config
# Use 'qemu_riscv64_virt_optee_llvm_defconfig' for Clang or 'qemu_riscv64_virt_optee_defconfig' for GCC
$ make qemu_riscv64_virt_optee_llvm_defconfig

# Build all components with AES and SHA-2 enabled
$ make -j$(nproc) CMAKE_POLICY_VERSION_MINIMUM=3.5 \
      CFG_CORE_CRYPTO_AES_ACCEL=y \
      CFG_CORE_CRYPTO_SHA256_ACCEL=y \
      CFG_CORE_CRYPTO_SHA512_ACCEL=y

# Start QEMU with '-cpu rv64,zkr=on,v=true,zvkng=true,zvbb=true'
$ ./output/images/start-qemu-vector.sh

# Open a console and telnet to launch the kernel
$ telnet localhost 64320

# Run the relevant xtest after kernel login to verify AES and SHA-2
$ xtest 4001 4002 4003 4005 4017 1013

# Or just run all xtest
$ xtest
```

The following OP-TEE regression tests all passed:

| Test | Coverage | Subtests | Failed |
|---|---|---:|---:|
| `xtest 4001` | SHA-2 hashes | 570 | 0 |
| `xtest 4002` | HMAC-SHA-2 and AES-CMAC paths | 3272 | 0 |
| `xtest 4003` | AES modes and XTS known-answer tests | 1997 | 0 |
| `xtest 4005` | AES-192/256 AEAD setup | 2486 | 0 |
| `xtest 4017` | AES streaming and boundary handling | 5465 | 0 |
| `xtest 1013` | Concurrent SHA-256 and context switching | 648 | 0 |

The SHA tests cover both digest and HMAC paths. The AES tests exercise the key
setup indirectly across ECB, CBC, CTR, XTS, CMAC, and streaming cases. The
concurrent SHA test exercises repeated secure-world scheduling while the vector
context remains isolated properly.

# Scope Boundaries

This work targets RVA23-class systems with RVV crypto. It intentionally does
not include:

  - RVA22 support
  - RISC-V scalar cryptography acceleration
  - run-time detection of `Zvkng` or `Zvksg`
  - RVV acceleration inside LibTomCrypt or Mbed TLS directly
  - SHA-1, SHA-3, SM3, or SM4 acceleration

# Upstreaming Impact

This work establishes the structure for RISC-V RVV crypto in OP-TEE:
configuration discipline, imported low-level transforms, and `crypto_drv` glue.
With this integration, OP-TEE has a full accelerated implementation for the
assigned AES and SHA-2 `crypto_drv` functions while retaining the software
fallback whenever the feature is not selected. This provides a practical RVV
crypto path for RISC-V TEE systems without changing the default behavior on
existing platforms.
