---
layout: post
title: "RISC-V: OpenSBI Interrupt Abstraction Design and APLIC M-mode Support"
---
# Overview

This post is about the design of an OpenSBI interrupt abstraction layer
and APLIC (Advanced Platform Level Interrupt Controller) implementation
I recently did for RISE (RISC-V Software Ecosystem) [RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V).

## Deliverable

A new hierarchical abstraction of interrupt handling with implementation
for APLIC was introduced to OpenSBI.

The extended IRQ chip hierarchy is flexible for other wired interrupt
sources other than APLIC without modifying trap-level logic.

A new IRQ chip provider interface is introduced for OpenSBI drivers to
register IDC claim, complete, mask and unmask function hook per wired
interrupt line.

Test routine is added with full coverage for a demo through “WFI → UART
(wired IRQ) → APLIC → IDC.CLAIMI → OpenSBI trap → registered INTC
provider → handler → clean UART → complete → return to WFI” to prove a
complete interrupt handling path in M-Mode is working.

## Status

Validated on QEMU virt (`-M virt,aia=aplic`)

# Background and Motivation

RISC-V Advanced Interrupt Architecture (AIA) introduces the APLIC
(Advanced Platform-Level Interrupt Controller) to manage wired
(platform) interrupts and routes them to harts or MSI (Message Signaled
Interrupt) endpoints.

In the current OpenSBI implementation, APLIC support primarily focuses
on initialization and delegation, while M-mode external interrupt
handling for wired interrupts remains largely stubbed. As a result:

  - Real wired interrupts cannot be handled end-to-end in M-mode.
  - There is no generic mechanism for OpenSBI drivers or platforms to 
    register handlers for wired interrupt lines.
  - Trap-level interrupt dispatch remains tightly coupled to specific 
    IRQ chip implementations.

The goal of this work is to flesh out minimal first-level wired
interrupt support for APLIC in M-mode, while introducing a small,
extensible abstraction that avoids hard-coding APLIC-specific logic into
the trap handler.

## Design Goals

1.  Enable real wired interrupt handling in M-mode
      - Support end-to-end delivery of platform interrupts (e.g. UART
        RX).
2.  Keep the design minimal and generic
      - Avoid embedding APLIC-specific details in trap handling.
3.  Provide a reusable abstraction
      - Allow future interrupt controllers (PLIC, SoC-private IRQs,
        etc.) to integrate with the same model.
4.  Validate using real hardware behavior
      - Use UART RX on QEMU virt for testing.

## Non-goals

  - MSI (Message Signaled Interrupt) / IMSIC (Incoming Message
    Signaled Interrupt Controller) support
  - S-mode interrupt couriering (Rp016-M3)

## Terminology

  - Wired IRQ  
    - A physical interrupt line asserted by a device (e.g. UART RX),
      as opposed to message-signaled interrupts (MSI).
  - Root APLIC  
    - The M-mode APLIC domain responsible for delivering wired
      interrupts directly to harts.
  - IDC (Interrupt Delivery Controller)  
    - Per-hart APLIC component responsible for final interrupt
      delivery and interrupt claiming.

# High-Level Architecture

## Design overview

1.  Introducing a minimal, generic abstraction
    (claim/complete/mask/unmask) for wired interrupt handling in
    OpenSBI.
2.  Using this abstraction to implement APLIC wired interrupt support
    in M-mode.
3.  Providing a QEMU virt-specific test based on UART RX to validate
    the complete interrupt lifecycle.

## Interrupt Handling Abstraction

A new provider abstraction is introduced to represent wired interrupt
controllers:

```
struct sbi_irqchip_provider_ops {

/*
 * Claim a pending wired interrupt on current hart.
 * Returns:
 * SBI_OK : *hwirq is valid
 * SBI_ENOENT : no pending wired interrupt
 * <0 : error
 */
int (*claim)(void *ctx, u32 *hwirq);

/*
 * Complete/acknowledge a previously claimed wired interrupt
 * (if required by HW).
 * Some HW may not require an explicit completion.
 */
void (*complete)(void *ctx, u32 hwirq);

/*
 * mask/unmask a wired interrupt line.
 *
 * These are required for reliable couriering of
 * level-triggered device interrupts to S-mode:
 * mask in M-mode before enqueueing, and unmask
 * after S-mode has cleared the device interrupt source.
 */
void (*mask)(void *ctx, u32 hwirq);
void (*unmask)(void *ctx, u32 hwirq);

};
```

Key properties:
  - `claim()` returns a hardware IRQ ID (`hwirq`).
  - `complete()` signals end-of-interrupt.
  - `mask()` and `unmask()` enable/disable the interrupt source.
  - Independent of the underlying controller (APLIC, PLIC, etc.).

A central dispatcher:
  - Maps `hwirq` to the registered handler.
  - Invokes handler.
  - Calls `complete()`.

This abstraction allows OpenSBI to support multiple interrupt
controllers without modifying trap-level logic.

## APLIC Wired Interrupt Provider

APLIC is integrated by implementing the `irqchip` provider interface.

### Claim Semantics

For wired interrupts, APLIC provides the `IDC.CLAIMI` register:

  - Reading `IDC.CLAIMI`:
      - Returns a non-zero `hwirq` if pending.
      - Atomically marks the interrupt as "in service".
  - Returning `0` indicates no pending interrupt (spurious).

Implementation:
  - `claim()` reads `IDC.CLAIMI` and extracts the `hwirq`.
  - If no pending interrupt exists, the claim fails gracefully.

### Completion Semantics

After handler execution:
  - The interrupt source must be cleared at the device level.
  - `complete()` finalizes the interrupt lifecycle (EOI bookkeeping).

For QEMU APLIC:
  - Writing `CLAIMI` is not required.
  - Correct device-side clearing is sufficient.

### Mask/Unmask Semantics

For wired interrupts, APLIC provides `SETIENUM` and `CLRIENUM` registers.
  - `mask()` enables the interrupt source by writing the `hwirq` to
    `SETIENUM`.
  - `unmask()` disables the interrupt source by writing the `hwirq` to
    `CLRIENUM`.

## Trap Handling Integration

### CPU-Level Conditions

A wired interrupt is delivered to M-mode when:
  - `mstatus.MIE == 1`
  - `mie.MEIE == 1`
  - `mip.MEIP == 1`

This results in:
  `mcause = 0x8000_0000_0000_000b`

(Machine External Interrupt)

### OpenSBI Trap Flow

The trap handler decodes `mcause` and dispatches machine external
interrupts to the registered external interrupt handler.

With our design:
  - The external interrupt path invokes
    `sbi_irqchip_handle_external_irq()`.
  - The irqchip registered dispatcher performs: 
    1.  `provider->claim()`
    2.  handler lookup and invocation
    3.  `provider->complete()`

This removes the need for APLIC-specific logic in the trap handler.

## UART-Based Testing Code

### Why UART?

UART RX is an ideal validation source because:
  - It is a real wired interrupt.
  - It is level-triggered.
  - Its interrupt behavior is easy to observe and reason about.

### Test Setup (QEMU virt)

  - Platform: `qemu-system-riscv64 -M virt,aia=aplic`
  - UART IRQ line: `hwirq` 10
  - Root APLIC domain targets M-mode.

Key setup steps:
1.  Route UART `interrupt-parent` to the root APLIC domain.
2.  Configure APLIC:
      - `sourcecfg[10] = LEVEL_HIGH`
      - `target[10] = hart0`
      - `DOMAINCFG.DM = 0` (direct delivery)
3.  Enable IDC delivery (`IDELIVERY`, `ITHRESHOLD`).
4.  Enable CPU MEIP (`mstatus.MIE`, `mie.MEIE`).

### Handler Responsibilities

The UART interrupt handler must drain the RX FIFO by reading RBR until
empty, which clears the interrupt source and prevents interrupt storms
for level-triggered IRQs.

Expected behavior:
  - One interrupt per key press.
  - CPU returns to WFI after handling.

## End-to-End Interrupt Flow

```
UART RX
  → APLIC (root, wired)
    → IDC.CLAIMI
      → MEIP asserted
        → OpenSBI trap handler
          → irqchip IRQ dispatcher
            → registered UART handler
              → clear RX FIFO
            → complete
```

This demonstrates a full interrupt lifecycle:  
assert → claim → handle → clear → complete.

## Results and Validation
  - Wired UART interrupts are successfully delivered to M-mode.
  - `hwirq` is correctly claimed via `IDC.CLAIMI`.
  - Handlers are invoked exactly once per interrupt.
  - No interrupt storms occur after proper device-side clearing.

This validates:
  - The new IRQ chip abstraction.
  - The APLIC wired provider implementation.
  - The correctness of the trap-level integration.

# Build Steps and Test Instructions

All implementations are already merged into [RISE (RISC-V Software Ecosystem) Gitlab Projects](https://gitlab.com/riseproject/riscv-optee/) and ready for testing as part of the [RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V/) deliverables.

Get Buildroot source code:

The complete build & test environment is leveraging Buildroot as an umbrella project.
Get Buildroot code from the branch for RP016-M2:

```
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b
rp016_m2_aplic_v2
```

Configure Buildroot:

```
$ cd buildroot
$ make qemu_riscv64_virt_optee_defconfig
```

Build:

```
$ make -j$(nproc)
```

To avoid building errors due to outdated Buildroot native
CMakeLists.txt files, if you have a CMAKE version \> 3.30 on your host,
build with:

```
$ make -j$(nproc) CMAKE\_POLICY\_VERSION\_MINIMUM=3.5
```

This will build all of the required components. All build artifacts can
be found under `output/build`.

## Running OpenSBI and Linux

Start QEMU and launch the kernel:

```
$ ./output/images/start-qemu-kernel.sh
```

When the following output appears on the console, QEMU is waiting for a
pending connection.

```
qemu-system-riscv64: -chardev
socket,id=vc0,host=127.0.0.1,port=64321,server=on,wait=on: info: QEMU
waiting for connection on: disconnected:tcp:127.0.0.1:64321,server=on
```

Connect to QEMU via a new console by using telnet to port 64321:

```
$ telnet 127.0.0.1 64321
```

The Linux logs will appear on the new Linux console, while the OpenSBI
logs will appear on the original OpenSBI console.

By typing any key in the OpenSBI console, you should see logs below,
which indicates successful wired interrupt handling
(claimed/handled/completed) in M-mode.

```
[IRQCHIP] claim hwirq <IRQ_NUM>
[IRQCHIP] calling handler for hwirq <IRQ_NUM>
[APLIC TEST] UART got '<KEY_NAME>'(<KEY_ASCII>)
[IRQCHIP] complete hwirq <IRQ_NUM>
```

For example, if you press ‘a’, you should see:

```
[IRQCHIP] claim hwirq 10
[IRQCHIP] calling handler for hwirq 10
[APLIC TEST] UART got 'a'(0x61)
[IRQCHIP] complete hwirq 10
```

## Linux IRQ Tests

In Linux console, after logging in as root, confirm the APLIC is
registered properly:

```
$ dmesg | egrep -i "aplic|imsic|aia|irqchip|riscv-intc"
[    0.000000] riscv-intc: 64 local interrupts mapped
[    0.591472] riscv-aplic d000000.interrupt-controller: 96 interrupts directly connected to 2 CPUs
```

Check the IRQ status:

```
$ cat /proc/interrupts
           CPU0       CPU1       
 10:        974       1041 RISC-V INTC   5 Edge      riscv-timer
 12:         20          0 APLIC-DIRECT  33 Level     virtio2
 14:        560          0 APLIC-DIRECT   7 Level     virtio1
 15:        284          0 APLIC-DIRECT   8 Level     virtio0
 16:          0          0 APLIC-DIRECT  11 Level     101000.rtc
IPI0:        66         56  Rescheduling interrupts
IPI1:       244        323  Function call interrupts
IPI2:         0          0  CPU stop interrupts
IPI3:         0          0  CPU stop (for crash dump) interrupts
IPI4:         0          0  IRQ work interrupts
IPI5:         0          0  Timer broadcast interrupts
IPI6:         0          0  CPU backtrace interrupts
IPI7:         0          0  KGDB roundup interrupts
```

This shows that the APLIC M-mode wired interrupt implementation does
not affect the Linux IRQ mechanisms.

Try with a few more test steps to confirm IRQ affinity has no side
effects from our changes.

In the Linux console, enable hvc1:

```
$ setsid sh </dev/hvc1 >/dev/hvc1 2>&1
```

Connect to QEMU via a new console by using telnet to port 64322:

```
$ telnet 127.0.0.1 64322
```

Start tracking the IRQ status in this new monitor console:

```
$ watch -n 1 cat /proc/interrupts
```

The counters of APLIC-DIRECT are incrementing.

Keep testing in OpenSBI console by typing keys while monitoring the
counters in the monitor console, the IRQ status should not be affected.

Test the IRQ affinity on the source which is triggered most frequently,
for example, IRQ13 or IRQ14.

Bind the IRQ to CPU1:

```
$ echo 1 > /proc/irq/14/smp_affinity_list
```

The CPU0 counter stops incrementing and the CPU1 counter starts
incrementing.

Bind the IRQ to CPU0:

```
$ echo 0 > /proc/irq/14/smp_affinity_list
```

The CPU1 counter stops incrementing and the CPU0 counter resumes
incrementing.
This proves that OpenSBI APLIC changes have no side effects on the Linux
IRQ affinity.

More IRQ affinity tests can be performed, please reference on [Tune IRQ Affinity](https://documentation.ubuntu.com/real-time/latest/how-to/tune-irq-affinity/)

## Upstream Efforts

The patch set was posted to OpenSBI mailing list and ready for review:

[[PATCH 0/3] APLIC hwirq implementation for irqchip](https://lists.infradead.org/pipermail/opensbi/2026-February/009450.html)

[[PATCH 1/3] lib: sbi_irqchip: Add irqchip private context pointer in sbi_irqchip_device](https://lists.infradead.org/pipermail/opensbi/2026-February/009451.html)

[[PATCH 2/3] lib: utils: irqchip: implement APLIC hwirq operation hooks](https://lists.infradead.org/pipermail/opensbi/2026-February/009452.html)

[[PATCH 3/3][NOT-FOR-UPSTREAM] lib: utils: irqchip: add QEMU virt test for APLIC wired IRQs](https://lists.infradead.org/pipermail/opensbi/2026-February/009453.html)
