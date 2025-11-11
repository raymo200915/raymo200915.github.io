---
layout: post
title: "How UEFI Secure Boot Works in U-Boot"
---
# Overview

UEFI Secure Boot is a signature verification framework designed to
ensure that only trusted and authorized software is executed during the
boot process. Instead of allowing any EFI application or operating
system loader to run, Secure Boot requires each binary to be signed by a
key that is trusted by the platform. The platform firmware maintains a
set of signature databases, including the Platform Key (PK), Key
Exchange Keys (KEK), allowed-signature database (db), and
forbidden-signature database (dbx). During boot, each EFI binary is
authenticated against these databases, and execution is denied if the
signature is missing or invalid.

In the PC ecosystem, Secure Boot is commonly implemented by proprietary
firmware, but U-Boot also provides a fully functional Secure Boot
implementation within its UEFI subsystem. This allows embedded platforms
to adopt the same trust model used by standard UEFI systems, enabling
compatibility with components like shim, GRUB, and Linux distributions
that rely on Secure Boot for system integrity. When Secure Boot is
enabled in U-Boot, the firmware validates EFI images before execution
using X.509 certificates and PKCS\#7 signatures, ensuring that only
binaries approved by the system owner or OEM can run.

This article explains how U-Boot implements UEFI Secure Boot, how
signature verification is performed, and how keys are provisioned, with
hands-on steps to test a complete Secure Boot flow.

# Secure Boot Key Hierarchy in UEFI

UEFI Secure Boot is governed by a hierarchical key and signature
database structure. This hierarchy determines who is allowed to modify
security settings and which executables are permitted to run. The key
sets involved are:

<table>
<thead>
<tr class="header">
<th>Name</th>
<th>Purpose</th>
<th>Stored as EFI variable</th>
<th>Who Can Modify</th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td>PK (Platform Key)</td>
<td>Establishes platform ownership</td>
<td>PK</td>
<td>BIOS/U-Boot physical owner</td>
</tr>
<tr class="even">
<td><p>KEK</p>
<p>(Key Exchange Key)</p></td>
<td>Authorizes updates to allowed/forbidden signature databases</td>
<td>KEK</td>
<td>Holder of PK</td>
</tr>
<tr class="odd">
<td><p>db</p>
<p>(Allowed signatures)</p></td>
<td>List of trusted certificates, hashes, or signatures</td>
<td>db</td>
<td>Holder of KEK</td>
</tr>
<tr class="even">
<td><p>dbx</p>
<p>(Forbidden signatures)</p></td>
<td>List of explicitly revoked signatures</td>
<td>dbx</td>
<td>Holder of KEK</td>
</tr>
</tbody>
</table>

UEFI Secure Boot keys in U-Boot are stored as persistent EFI variables
located in the ESP (EFI System Partition). This follows the standard PC
UEFI implementation.

# Code Walkthrough: How U-Boot Verifies a UEFI Image

Below is the high-level call flow you’ll see when U-Boot loads and verifies
a PE/COFF EFI binary under Secure Boot:

```
efi_load_pe()
  └─ efi_image_authenticate()
       ├─ efi_image_parse()                  // find & parse WIN_CERTIFICATE entries
       ├─ efi_sigstore_parse_sigdb()         // parse db, dbx from ESP
       ├─ efi_signature_lookup_digest()      // check if image digest in dbx
       └─ for each WIN_CERTIFICATE:
            ├─ pkcs7_parse_message()         // extract certs, signers info, content data (AuthentiCode)
            ├─ efi_signature_verify[_one]()  // verify signers info chains, db/dbx policy
            │    └─ for each signer:
            │         └─ pkcs7_verify_one()  // verify one signer info
            │              └─ pkcs7_digest() // compare computed digest vs signed attrs
            ├─ efi_signature_check_signers() // check if signer in dbx
            └─ efi_image_verify_digest()     // Authenticode digest over the image matches?
```

## efi_load_pe() — Load the PE/COFF image

- Reads the EFI binary into memory (PE/COFF format).
- Locates the PE headers (DOS stub → NT headers → Optional Header → DataDirectory).
- Finds the Attribute Certificate Table via `OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_SECURITY]`.
- Hands the buffer to `efi_image_authenticate()` if Secure Boot is active.

Tip: the security directory points to a blob at the end of the file that is not covered by the PE checksum; that blob contains one or more `WIN_CERTIFICATE` structures.

## efi_image_authenticate() — Gatekeeper for Secure Boot

- Calls `efi_image_parse()` to enumerate certificate blobs.
- For each certificate blob (PKCS#7/Authenticode):
- Parses the PKCS#7.
- Verifies signer(s) cryptographically and against db/dbx policy.
- Validates that the signed Authenticode digest matches the digest computed over the image (`efi_image_verify_digest()`).
- Fails fast if any requirement is not met (missing signature, bad chain, revoked signer, digest mismatch, etc.).

## efi_image_parse() — Parse WIN_CERTIFICATE entries

What is `WIN_CERTIFICATE`?

It’s the container format Microsoft/UEFI use for signatures embedded in the PE file’s Attribute Certificate Table. The layout (simplified) is:

```
typedef struct {
    uint32_t dwLength;         // total length including header
    uint16_t wRevision;        // usually 0x0200
    uint16_t wCertificateType; // e.g. WIN_CERT_TYPE_PKCS_SIGNED_DATA (0x0002)
    uint8_t  bCertificate[];   // the actual payload (PKCS#7, etc.)
} WIN_CERTIFICATE;
```

UEFI also defines `WIN_CERTIFICATE_UEFI_GUID`, whose `CertType` is a GUID. For Secure Boot we typically see PKCS#7 (either classic `0x0002` or `EFI_CERT_TYPE_PKCS7_GUID`).

What this function does:

- Validates table bounds and iterates all `WIN_CERTIFICATE` records.
- For each record, checks `wCertificateType` or `CertType` GUID and keeps the PKCS#7 blobs for subsequent steps.

## pkcs7_parse_message() — Decode PKCS#7 and extract materials

For each WIN_CERTIFICATE it:

1) Parses the SignedData structure:

  - Certificates (X.509 chain the signer might include).

  - SignerInfo entries (could be multiple signers).

    Signed attributes (PKCS#9), including:

    - messageDigest — digest of the content that the signer claims.

    - contentType — OID of the content.

    - signingTime — optional.

  - Content data (for Microfost Authenticode this is an indirect data object, not the whole file).

    In Authenticode, the content is usually `SPC_INDIRECT_DATA_OBJID` (OID in the Microsoft “1.3.6.1.4.1.311.*” arc) that carries:

  - the digest algorithm (e.g., SHA-256), and
  - the expected digest value of the PE image (computed with Authenticode rules).

2) Makes the certs + signers + content available for verification.

## efi_signature_verify(_one)() — Signer validation

Purpose: accept only signatures that are valid and authorized by UEFI Secure Boot policy.

For each SignerInfo:

- Chain build & crypto check
- Use the certs from the PKCS#7 plus any platform trust anchors to build a chain.
- Verify the signature over the signed attributes with the signer’s public key.
- This is where pkcs7_verify_one() performs the cryptographic validation:
  - The signature (RSA/ECDSA) must match the DER-encoded SignedAttrs.
  - The pkcs7_digest() helper computes the digest of the signature and compares with the messageDigest attribute (PKCS#9 Authentication Attributes). If those diverge, the signer fails.

  An example of PKCS#9 Authentication Attributes (`contentType`=`SPC_INDIRECT_DATA_OBJID`) embedded with `messageDigest` (encoded in ASN1 DER format):

  ```
  [C.P.0] {
    U.P.SEQUENCE {
        U.P.OBJECTIDENTIFIER 1.2.840.113549.1.9.3 (contentType)
        U.P.SET {
          U.P.OBJECTIDENTIFIER 1.3.6.1.4.1.311.2.1.4 (SPC_INDIRECT_DATA_OBJID)
        }
    }
    U.P.SEQUENCE {
        U.P.OBJECTIDENTIFIER 1.2.840.113549.1.9.5 (signingTime)
        U.P.SET {
          U.P.UTCTime '240116205129Z'
        }
    }
    U.P.SEQUENCE {
        U.P.OBJECTIDENTIFIER 1.2.840.113549.1.9.4 (messageDigest)
        U.P.SET {
          U.P.OCTETSTRING 038bbd9aae6059a2ab6dbe813c47220a7f5c152fbbd047bb7d07688a39683dbb
        }
    }

  ...

  }
  ```

## efi_signature_check_signers() — Policy validation

Authorize the signer via db/dbx

- Extract the signer’s cert (or its hash) and check:

  - Allowed? Match against db (can contain X.509 certs, hashes, or signatures).

  - Not revoked? Ensure it’s not in dbx (revocation list).

- If the signer is not authorized by db, skip it.

- If the signer presents in dbx, reject immediately.

- (Optional) Time validity / EKU checks

  If implemented, the chain validity period and EKU/OID constraints must pass.

Blacklist always takes precedence. If any signature, image hash, or signer certificate matches dbx, authorization fails immediately. Otherwise, the image is authorized if at least one signer passes cryptographic verification and is trusted by db (and not present in dbx). If all signers fail, the image is rejected.

## efi_image_verify_digest() — Authenticode file-digest check

This step ties the signature to the actual PE/COFF file contents.

- From the parsed Authenticode from the Content Data (`SpcIndirectData`), obtain:

  - Digest algorithm (e.g., SHA-256).

  - Expected digest.

- Compute the Authenticode digest over the loaded image using the same algorithm, with Authenticode hashing rules:

  - Hash most of the PE image except:

    The Attribute Certificate Table itself (pointed by `IMAGE_DIRECTORY_ENTRY_SECURITY`).

    Any regions that the spec says must be zeroed or excluded (e.g., certain header fields are treated specially).

  - U-Boot follows the PE/COFF Authenticode spec for this computation.

  Excample of an Authenticode embedded with digest and digest algorithm (encoded in ASN1 DER format):

  ```
  U.P.SEQUENCE {
    U.P.SEQUENCE {
        U.P.OBJECTIDENTIFIER 2.16.840.1.101.3.4.2.1 (sha256)
        U.P.NULL 
    }
    U.P.OCTETSTRING 65c9fcbebb3341a67c84a273b74b81f3de8b17109b7b0af7e97ac591e2eb4ed0
  }
  ```

- Compare computed digest vs expected digest from the Content Data.

  - If they match → the signed statement actually covers this exact image.

  - If they don’t → reject (tampering or mismatch).

Only if both signer authorization and digest match succeed does efi_image_authenticate() return success, allowing execution.

# Hands-on steps to demo a UEFI Secure Boot

In this section, we will walk through a complete, hands-on workflow to test UEFI Secure Boot in U-Boot using QEMU. The goal is to reproduce the full Secure Boot verification flow end-to-end — from creating signing keys to booting a signed EFI application under U-Boot with signature enforcement enabled.

## Generate UEFI Secure Boot Certificates

Create a Platform Key (PK), Key Exchange Key (KEK), and allowed-signature database (db) using standard OpenSSL tooling.

- Generate private key PK.key and cert PK.crt

```
openssl req -x509 -sha256 -newkey rsa:2048 -subj /CN=TEST_PK/ -keyout PK.key -out PK.crt -nodes -days 365
```

- Generate PK esl and auth (GUID='11111111-2222-3333-4444-123456789abc', Timestamp='2020-4-1 00:00:00').

```
cert-to-efi-sig-list -g '11111111-2222-3333-4444-123456789abc' PK.crt PK.esl; sign-efi-sig-list -t "2020-04-01" -c PK.crt -k PK.key PK PK.esl PK.auth
```

- Create an empty esl for the noPK (noPK.esl) to reset secure boot. This essentially removes the PK to disable secure boot temporarily.

```
touch noPK.esl; sign-efi-sig-list -t "2020-04-02" -c PK.crt -k PK.key PK noPK.esl noPK.auth
```

- Generate private key KEK.key and cert KEK.crt.

```
openssl req -x509 -sha256 -newkey rsa:2048 -subj /CN=TEST_KEK/ -keyout KEK.key -out KEK.crt -nodes -days 365
```

- Generate KEK esl and auth (GUID='11111111-2222-3333-4444-123456789abc', Timestamp='2020-4-3 00:00:00').

```
cert-to-efi-sig-list -g '11111111-2222-3333-4444-123456789abc' KEK.crt KEK.esl; sign-efi-sig-list -t "2020-04-03" -c PK.crt -k PK.key KEK KEK.esl KEK.auth
```

- Generate private key db.key and cert db.crt.

```
openssl req -x509 -sha256 -newkey rsa:2048 -subj /CN=TEST_db/ -keyout db.key -out db.crt -nodes -days 365
```

- Generate db esl and auth (GUID='11111111-2222-3333-4444-123456789abc', Timestamp='2020-4-4 00:00:00').

```
cert-to-efi-sig-list -g '11111111-2222-3333-4444-123456789abc' db.crt db.esl; sign-efi-sig-list -t "2020-04-04" -c KEK.crt -k KEK.key db db.esl db.auth
```

- Generate private key dbx.key and cert dbx.crt

```
openssl req -x509 -sha256 -newkey rsa:2048 -subj /CN=TEST_dbx/ -keyout dbx.key -out dbx.crt -nodes -days 365
```

- Generate dbx esl and auth (GUID='11111111-2222-3333-4444-123456789abc', Timestamp='2020-4-5 00:00:00').

```
cert-to-efi-sig-list -g '11111111-2222-3333-4444-123456789abc' dbx.crt dbx.esl; sign-efi-sig-list -t "2020-04-05" -c KEK.crt -k KEK.key dbx dbx.esl dbx.auth
```

Alternatively, you can use [create-certs-and-keys.sh](https://github.com/raymo200915/u-boot-secure-boot-tooling/blob/main/create-certs-and-keys.sh) to generate all above certificates and keys in a single step.

## Build U-Boot

Build U-Boot qemu_arm64 with selecting `CONFIG_EFI_SECURE_BOOT` and `CONFIG_SEMIHOSTING`.

When enabling `CONFIG_EFI_SECURE_BOOT=y`, below options will be enabled automatically:

```
CONFIG_RSA_VERIFY_WITH_PKEY=y
CONFIG_ASYMMETRIC_KEY_TYPE=y
CONFIG_ASYMMETRIC_PUBLIC_KEY_SUBTYPE=y
CONFIG_RSA_PUBLIC_KEY_PARSER=y
CONFIG_X509_CERTIFICATE_PARSER=y
CONFIG_PKCS7_MESSAGE_PARSER=y
CONFIG_PKCS7_VERIFY=y
CONFIG_MSCODE_PARSER=y
CONFIG_ASN1_COMPILER=y
CONFIG_ASN1_DECODER=y
CONFIG_OID_REGISTRY=y
CONFIG_EFI_SIGNATURE_SUPPORT=y
```

After building, we have `u-boot.bin` and an EFI test image `helloworld.efi`.

## Sign an EFI test Application

Sign the EFI test image by:

```
sbsign --key db.key --cert db.crt --output helloworld-signed.efi helloworld.efi
```

Verify the signed image by:

```
sbverify --cert db.crt helloworld-signed.efi
```

## Create an image that contains the EFI image and the UEFI certs

Place the EFI test image and UEFI certs into a folder \<FILE_DIR\>

```
virt-make-fs --partition=gpt --size=+1M --type=vfat <FILE_DIR> <OUTPUT_IMAGE_NAME>
```

For example:

```
virt-make-fs --partition=gpt --size=+1M --type=vfat uefi_certs test_efi_secboot.img
```

## Run U-Boot on QEMU and Verify Secure Boot Behavior

Run U-Boot with mounting the created image as a virtio device

```
qemu-system-aarch64 -bios u-boot.bin -machine virt -cpu cortex-a57 -smp 1 -m 4G -d unimp -nographic -serial mon:stdio -semihosting -drive if=none,file=<OUTPUT_IMAGE_NAME>,format=raw,id=hd0 -device virtio-blk-device,drive=hd0
```

After launching U-Boot console, check if the EFI test image file (`helloworld-signed.efi` and `helloworld.efi`) and UEFI certs exist in the virtio partition (e.g. partition 1)

```
ls virtio 0:1
```

Load the signed EFI image file from the virtio partition into a memory address (`$loadaddr`, Check the variable `loadaddr` by `printenv`)

```
load virtio 0:1 ${loadaddr} helloworld-signed.efi
```

Load UEFI certs from the virtio partition and save them as EFI variables (PK, KEK, db, dbx)

```
load virtio 0:1 90000000 PK.auth && setenv -e -nv -bs -rt -at -i 90000000:$filesize PK
load virtio 0:1 90000000 KEK.auth && setenv -e -nv -bs -rt -at -i 90000000:$filesize KEK
load virtio 0:1 90000000 db.auth && setenv -e -nv -bs -rt -at -i 90000000:$filesize db
load virtio 0:1 90000000 dbx.auth && setenv -e -nv -bs -rt -at -i 90000000:$filesize dbx
```

Below errors can be ignored since we do not have RPMB to save NV when running in qemu:

```
No EFI system partition
Failed to persist EFI variables
```

(Optional) To remove these errors by skipping saving EFI variables into NV via below Kconfig settings:

```
# CONFIG_EFI_VARIABLE_FILE_STORE is not set
CONFIG_EFI_VARIABLE_NO_STORE=y
# CONFIG_EFI_VARIABLES_PRESEED is not set
```

Boot the EFI image file from the memory address (`fdt_addr` is optional is you want to run with a specified Device Tree)

```
bootefi ${loadaddr} ${fdt_addr}
```

Below prompt logs indicate a successful UEFI Secure Boot process.

```
Hello, world!
Running on UEFI 2.10
```

For comparison, you can try to boot the `helloworld.efi` and it will end up with authentication failure since it is unsigned.

# Summary

UEFI Secure Boot in U-Boot provides a standards-based trust model that aligns embedded platforms with the broader UEFI ecosystem used in PCs and servers. Instead of relying on a board-specific or fuse-anchored trust chain, U-Boot stores its Secure Boot policy (PK, KEK, db, and dbx) as EFI variables on the EFI System Partition. This allows key provisioning, rotation, and revocation to be managed dynamically via Linux tooling.

When loading an EFI executable, U-Boot inspects the PE/COFF image, parses the PKCS#7 structures, evaluates the signer certificates against the allowed (db) and revoked (dbx) signature databases, verifies the cryptographic signature integrity, and finally confirms that the signed digest actually corresponds to the image content using the Authenticode hashing rules. Only if all validation layers succeed is the image executed.

This makes Secure Boot enforcement in U-Boot both cryptographically and policy-controlled, matching the behavior expected by modern Linux distributions, shim, and GRUB. The testing workflow we covered — generating UEFI certs, signing an EFI binary, and running U-Boot on QEMU — provides a reproducible foundation for understanding, experimenting, and demonstrating full featured UEFI Secure Boot flow.
