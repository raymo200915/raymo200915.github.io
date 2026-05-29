---
layout: post
title: "RISC-V: Virtual IRQ Mapping, Routing, and Couriering in OpenSBI"
---
# Overview

This post is about the design of an OpenSBI Virtual IRQ framework with APLIC (Advanced Platform Level Interrupt Controller) implementation
I recently did for RISE (RISC-V Software Ecosystem) [RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V).

## Deliverable

A lightweight VIRQ (Virtual IRQ) mapping / routing / couriering / domain switching subsystem is introduced in OpenSBI to support paravirtual / trap-and-emulate style interrupt dispatching to S-mode payloads, while keeping host physical interrupts handled in M-mode.

VIRQ layer provides:
  - stable and scalable per-MPXY(Message Proxy)-channel mapping between HWIRQ (Hardware IRQ) and VIRQ,
  - Devicetree-driven domain routing rules,
  - Per-(domain,hart) pending queue couriering and state management,
  - SEIP (Supervisor External Interrupt Pending)-based notification,
  - Domain-aware VIRQ couriering that allows switching context to the target domain and returning to the previous domain after VIRQ queue drained, and
  - ECALL(Environment Call) extension to pop and complete an enqueued VIRQ.

A test routine is provided to demonstrate the full coverage of the complete IRQ handling path for UART RX (receiver) (HWIRQ 10) from M-mode to an S-mode payload (bare-metal application) using:
  - Devicetree routing rules population and VIRQ handler registration during cold boot
  - HWIRQ / VIRQ mapping and routing to the destination domain when a HWIRQ is asserted during run-time
  - HWIRQ masking, VIRQ enqueue and SEIP notification
  - Domain context switch will be carried on if the target domain is not the current one
  - The S-mode payload traps the SEIP, pops the pending VIRQ via ECALL, and runs the interrupt service routine (ISR), then
  - completes the interrupt via ECALL, followed by unmasking the HWIRQ, allowing further interrupts to occur
  - When all pending VIRQs are handled, context switches and returns to the previous domain if applicable

## Status

Implementation is complete and validated on QEMU virt (`-M virt,aia=aplic`), version: 10.1.93.

# Background and Motivation

In current RISC-V systems using OpenSBI, host interrupts (HWIRQs) are typically handled in M-mode (Implemented by [RISC-V: OpenSBI Interrupt Abstraction Design and APLIC M-mode Support](https://raymo200915.github.io/2026/03/09/APLIC-M-mode-Wired-Interrupt-Support-in-OpenSBI.html)). S-Mode payloads (Linux, RTOS, or bare-metal applications) rely on standard interrupt delegation or platform-specific mechanisms. Domain isolation allows partitioning harts and resources, but interrupt routing across domains remains coarse-grained.

To support paravirtualization and trap-and-emulate interrupt models while M-mode retains ownership of physical IRQ lines, a mechanism is required to:
  - keep physical IRQ ownership in M-mode
  - route selected interrupts to their destination domains
  - deliver them in a controlled, queue-based manner
  - proceed the domain switch when the target domain differs from the current one
  - allow S-mode payloads to explicitly acknowledge and complete interrupt delivery

These requirements drove the design of the VIRQ subsystem that can be cleanly integrated with the existing IRQCHIP abstraction in OpenSBI.

## Design Goals

1. HWIRQ domain routing rules should be part of the domain configuration and flexible to extend.
2. S-mode does not need to know physical interrupt topology.
3. VIRQ pending queue should be managed per-domain and per-hart.
4. All enqueued VIRQs should be handled in a FIFO strategy (First-come-first-served).
5. Domain context switch is required if the target domain differs from the current domain.
6. The design and implementation can be demonstrated and verified using UART RX (receiver).

## Non-goals

  - Per-hart arbitrary IRQ priorities
  - RPMI-SYSIRQ-based delivery (will be in the next phrase)
  - Yield ECALL extension for OP-TEE (will be in the next phrase)

# High-Level Architecture

## Design Overview

The VIRQ layer is composed of 4 major parts:
1. HWIRQ / VIRQ mapping and allocation
  - Provides a stable per-MPXY-channel mapping between a host interrupt endpoint (`chip_uid`, `hwirq`) and a VIRQ number.
  - VIRQ number allocation uses a growable bitmap.
2. HWIRQ / domain routing rules
  - Routing rules are described in Devicetree using Linux IRQ standard property interrupts-extended under node `/chosen/opensbi-domains/rpmi_sysirq_intc` which emulates an MPXY channel for a particular domain by `opensbi,mpxy-channel-id`.
  - Each entry is converted and cached as a routing rule.
  - Default behavior for compatible fallback purpose: if an asserted HWIRQ does not match any routing rule, it will be routed to the root domain (MPXY channel 0).
3. Per-(domain,hart) pending queue couriering
  - Each domain maintains a per-hart ring buffer queue of pending VIRQs.
  - On an asserted HWIRQ, the registered VIRQ handler maps (`chip_uid`, `hwirq`) to a VIRQ number, looks up for destination domain via routing rules, masks the host HWIRQ (to avoid level-trigger storms), pushes the VIRQ into the per-(domain,hart) pending queue and set SEIP to notify the S-mode payload.
  - During VIRQ dispatching, domain context switch is available for entering to and returning from the target domain, if it defers from the current domain.
4. VIRQ ECALL extension
  - ECALL extension provides pop and complete functionality to retrieve and finish the next pending VIRQ from the per-(domain,hart) queue for an S-mode payload trapped by SEIP.

## HWIRQ / VIRQ Mapping and Allocation

VIRQ mapping model: VIRQ number allocation via growable bitmap - capacity expands as needed, memory usage scales with the number of active mappings.
  - Forward lookup [`(chip_uid,hwirq)` to VIRQ] is via dynamic vector of entries.
  - Reverse lookup [VIRQ to `(chip_uid,hwirq)`] is via a chunked table allocated on demand.

The mapping is per-MPXY-channel, that means each MPXY channel owns one map.

The mapping is stable across runtime (until reboot) and it is chip-agnostic via chip_uid of an irqchip instance (works for APLIC, PLIC, IMSIC, etc.), thus S-mode does not need to know physical interrupt topology, and routing and queueing logic remains generic.

```c
/* Entry of reverse mapping table: represents (chip_uid,hwirq) endpoint */
struct virq_entry {
    u32 chip_uid;
    u32 hwirq;
};

/* Chunked reverse mapping table: VIRQ -> (chip_uid,hwirq) */
struct virq_chunk {
    struct virq_entry e[VIRQ_CHUNK_SIZE];
};

struct map_node {
    u32 chip_uid;
    u32 hwirq;
    u32 virq;
};

struct sbi_virq_map {
    spinlock_t lock;

    /* allocator bitmap */
    unsigned long *bmap;

    u32 bmap_nbits; /* virq range: [0..nbits-1] */

    /* reverse table: virq -> endpoint */
    struct virq_chunk **chunks;

    u32 chunks_cap; /* number of chunk pointers */

    /* forward table: vector of mappings, linear search */

    struct map_node *nodes;

    u32 nodes_cnt;

    u32 nodes_cap;
};

struct sbi_virq_map_list {
    u32 channel_id;
    struct sbi_virq_map map;
};
```

A public API for VIRQ mapping is available to:
  - initialize allocator;
  - allocate a new mapping or return an existing mapping;
  - perform forward lookup;
  - perform reverse lookup;
  - unmap entries.

See the section [Mapping API](#mapping-api) for the detailed programming interface.

## HWIRQ / Domain Routing Rules

Routing rules are described in Devicetree property `interrupts-extended` under node `/chosen/opensbi-domains/rpmi_sysirq_intc`.

For example:

```dts
rpmi_sysirq_intc: interrupt-controller {
  compatible = "opensbi,mpxy-sysirq";
  interrupt-controller;
  #interrupt-cells = <1>;
  interrupts-extended = <&aplic HWIRQ IRQ_TYPE>, // virq 0
                        <&aplic HWIRQ IRQ_TYPE>; // virq 1
  opensbi,mpxy-channel-id = <4>; // per system design
  opensbi,domain = <&domain1>;
};
```

VIRQ numbers are allocated from zero, implicit from the order of the entries within the `interrupts-extended` property, and each pair `<&aplic HWIRQ IRQ_TYPE>` internally stored as:

```c
struct sbi_virq_route_rule {
    u32 hwirq;
    struct sbi_domain *dom; /* owner domain */
    u32 channel_id; /* MPXY channel */
};
```

When a HWIRQ is asserted, the VIRQ layer:
1. check routing rules.
2. if matched → routes HWIRQ to the destination domain.
3. if no match → routes HWIRQ to the root domain.

This ensures:
  - backward compatibility with the domains without an explicit routing rule,
  - safe default behavior.

A public API for VIRQ routing is available to:
  - reset routing state;
  - add a new routing rule to a domain;
  - lookup the destination domain for a given HWIRQ.

See the section [Routing API](#routing-api) for the detailed programming interface.

## Per-(domain,hart) Pending Queue Couriering

Each domain maintains a per-hart ring buffer queue of pending VIRQs with a conceptual structure:

```text
domain
├── hart0 queue
├── hart1 queue
└── ...
```

When a HWIRQ is asserted, after being mapped into a VIRQ and routed to a destination domain, it will:
1. mask the physical HWIRQ,
2. push VIRQ into (domain, hart) queue,
3. switch domain if the target domain differs from the current one, and
4. set SEIP notification.

Data structure using for per-domain VIRQ state management:

```c
/*
 * Per-(domain,hart) VIRQ state.
 *
 * Locking:
 * - lock protects head/tail and q[].
 *
 * Queue semantics:
 * - q[] stores VIRQs pending handling for this (domain,hart).
 * - enqueue is performed by M-mode according to route rule
 * populated from DT.
 * - pop/complete is performed by S-mode payload running in the
 * destination domain on the current hart.
 * - chip caches the irqchip device for unmasking on complete.
 */
struct sbi_domain_virq_state {
    spinlock_t lock;
    u32 head;
    u32 tail;

    /* Pending VIRQ ring buffer. */
    struct {
        u32 virq;
        u32 channel_id;
        struct sbi_irqchip_device *chip;
    } q[VIRQ_QSIZE];

    /* Return to previous domain after VIRQ completion. */
    bool return_to_prev;
};

/*
 * Per-domain private VIRQ context.
 *
 * Attached to struct sbi_domain and contains per-hart states.
 */
struct sbi_domain_virq_priv {
    /* number of platform harts */
    u32 nharts;

    /* number of allocated per-hart states */
    u32 st_count;

    /*
     * per-hart VIRQ state pointer array (indexed by hart index)
     */
    struct sbi_domain_virq_state *st_by_hart[];
};
```

A public API for VIRQ couriering is available to:
  - enqueue a VIRQ to the destination domain / hart;
  - pop the next pending VIRQ for the destination domain / hart;
  - complete a previously couriered VIRQ for the destination domain / hart;
  - courier handler for registration as an IRQCHIP callback.

See the section [Courier API](#courier-api) for the detailed programming interface.

## VIRQ ECALL Extension

A vendor-defined SBI extension provides two operations:

1. POP
Retrieve the next pending VIRQ from the current (domain, hart) queue.

2. COMPLETE
Mark the VIRQ as handled and unmask the underlying physical HWIRQ.

```c
/* Vendor extension base range is defined by the SBI spec. Choose a private ID. */
#define SBI_EXT_VIRQ 0x0900524d

/* Function IDs for SBI_EXT_VIRQ */
#define SBI_EXT_VIRQ_POP 0
#define SBI_EXT_VIRQ_COMPLETE 1
```

`SBI_EXT_VIRQ_POP` returns the next pending VIRQ for the current execution context. `SBI_EXT_VIRQ_COMPLETE` acknowledges that VIRQ and re-enables the routed HWIRQ so later interrupts can be delivered.

## S-mode Handling (Bare-metal Application Test Payload)

The bare-metal application changes for this milestone include:
- SEIP setup and enablement
- UART interrupt enablement
- SEIP trap handling
- ECALL wrappers for POP and COMPLETE
- Simple VIRQ/HWIRQ lookup for the demo payload
- UART RX ISR for end-to-end validation

On SEIP trap, the bare-metal application calls POP to get the next pending VIRQ, runs the ISR, clears the device interrupt source, and then calls COMPLETE so M-mode can unmask the physical interrupt again.

## UART RX (Receiver) End-to-End Interrupt Flow

```text
UART RX
  → APLIC
    → IDC.CLAIMI
      → MEIP asserted
        → OpenSBI trap handler
          → IRQCHIP IRQ handler
            → VIRQ registered handler
              → HWIRQ->VIRQ mapping
              → Route VIRQ to the destination domain
              → Enqueue VIRQ, mask HWIRQ
              → Domain context switch (when target dom != current dom)
              → SEIP set
                → S-mode SEIP trap handler
                  → Pop VIRQ from queue via ECALL
                  → UART RX ISR
                  → clear RX FIFO
                  → Complete VIRQ via ECALL (unmask HWIRQ)
                  → Repeat pop / complete until queue is empty
              → SEIP clear
              → Return context switch (when previous switch occured)
```

```text
                           M-mode                                                                        S-mode
-------------------------------------------------------------------------------------------------------------------------------
                    +----------------+
                    | HWIRQ asserted |
                    +----------------+
                             |
                             v
              +-----------------------------+
              | sbi_irqchip_raw_handler     |
              | call irqchip->process_hwirq |
              +-----------------------------+
                             |
                             v
      +----------------------------------------------+
      | irqchip claim path (for example APLIC)       |
      | - claim hwirq                                |
      | - call sbi_virq_courier_handler(chip, hwirq) |
      +----------------------------------------------+
                             |
                             v
  +-------------------------------------------------------+
  | sbi_virq_courier_handler                              |
  | - route_lookup(hwirq -> target domain, channel_id)    |
  | - map_one(channel_id, chip->id, hwirq -> virq)        |
  | - mask hwirq                                          |
  | - enqueue virq into target domain queue for this hart |
  +-------------------------------------------------------+
                             |
                             v
             +----------------------------------+
             | target domain == current domain? |
             +----------------------------------+
                  | yes                     | no
                  v                         v
+--------------------------------+  +----------------------------------+
| ensure S-mode notify is set    |  | mark pending notify for target   |
| sbi_irqchip_notify_smode_set() |  | set return_to_prev for target    |
+--------------------------------+  | sbi_domain_context_enter(target) |
                  |                 | if needed, set S-mode notify     |
                  |                 +----------------------------------+
                  |                         |
                  +----------+--------------+
                             |
                             v
           +-----------------------------------+
           | return SBI_EALREADY               | SEIP delegated to current S-mode context     +--------------------------+
           | raw handler skips EOI             |--------------------------------------------->| S-mode SEIP trap handler |
           | irqchip keeps completion deferred |                                              +--------------------------+
           +-----------------------------------+                                                           |
                                                                                                           |
                                                                                                           v
               +----------------------------+       ecall to M-mode                            +------------------------+
               | ecall handler for POP      |<-------------------------------------------------| ecall POP pending VIRQ |<-----+
               | sbi_virq_pop_thishart()    |                                                  +------------------------+      |
               |   pop domain Q             |                                                                                  | 
               |   clear SEIP if Q is empty |      ecall return VIRQ to S-mode                   +-------------------+         |
               |                            |--------------------------------------------------->| VIRQ ISR handling |         |
               +----------------------------+                                                    +-------------------+         |
                                                                                                           |                   |
                                                                                                           v                   |
           +----------------------------------+           ecall to M-mode                   +-----------------------------+    |
           | ecall handler for COMPLETE       |<--------------------------------------------| ecall COMPLETE pending VIRQ |    |
           | sbi_virq_complete_thishart(virq) |                                             +-----------------------------+    |
           |   call EOI if present            |                                                            :                   |
           |   unmask hwirq                   |       ecall return to S-mode                               : POP until Q empty |
           |   clear SEIP if Q is empty       |----------------------------------------------------------->|-------------------+
           +----------------------------------+
                             |
                             v
           +-------------------------------------+
           | Is a return domain switch required? |
           | sbi_virq_return_to_prev_if_needed() |
           +-------------------------------------+
             | no                              | yes
             |                                 | in next M-mode trap return path
             v                                 v
+------------------------+  +------------------------------------------------+                 +------------------------+
| stay in current domain |  | sbi_trap_handler()                             |                 | resume previous S-mode |
+------------------------+  | - if need_return_to_prev(): exit_to_prev()     |---------------->| domain context         |
                            | - consume_switched() updates trap exit context |                 +------------------------+
                            +------------------------------------------------+
```

This demonstrates a full interrupt lifecycle:
assert → claim → map → route → enqueue → notify → dequeue → handle → complete.

# Build Steps and Test Instructions

## Testing System Architecture

Our test is running on a 4 CPUs QEMU virt system:
Hart 0 / 1 for Linux:
- Linux runs as an S-mode payload of the root domain.

Hart 2 for bare-metal applications:
- Bm-app1 runs as an S-mode payload of domain1.
- Bm-app2 runs as an S-mode payload of domain2.

Hart 3 is free.

The goal is to demonstrate that UART RX (HWIRQ 10) interrupts are mapped, routed, and couriered to bare-metal applications according to Devicetree routing rules, without impacting Linux interrupt handling.

```text
              +--------------------+
              | OpenSBI            |
              | (M-mode)           |
              |--------------------|
              | Domain Manager     |
              | VIRQ mapping       |
              | VIRQ routing       |
              | VIRQ couriering    |
              | SEIP notification  |
              +---------+----------+
                        |
      +-----------------+------------------+
      |                                    |
 +----v----+                     +---------v---------+
 | hart0/1 |                     |       hart2       |
 +---------+                     +---------+---------+
 | root    |                     | domain1 | domain2 |
 | Linux   |                     | bm-app1 | bm-app2 |
 +---------+                     +---------+---------+
```

## Build via Buildroot Project

All implementations are already merged into [RISE (RISC-V Software Ecosystem) Gitlab Projects](https://gitlab.com/riseproject/riscv-optee/) and ready for testing as part of the [RP016 project](https://lf-rise.atlassian.net/wiki/spaces/HOME/pages/699924494/Project+RP016+OpenSBI+feature+additions+to+support+TEEs+for+RISC-V/) deliverables.

The OpenSBI patches and test bare-metal application can be found at:
https://gitlab.com/riseproject/riscv-optee/opensbi/-/tree/rp016_m3_virq_v3
https://gitlab.com/riseproject/riscv-optee/bm-app/-/tree/rp016_m3_virq_v2

The complete build & test environment is leveraging Buildroot as an umbrella project.
Get Buildroot code from the branch for RP016-M3:

```bash
$ git clone https://gitlab.com/riseproject/riscv-optee/buildroot.git -b rp016_m3_virq_v3
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

If your host has CMake > 3.30, build with:

```bash
$ make -j$(nproc) CMAKE_POLICY_VERSION_MINIMUM=3.5
```

All build artifacts can be found under `output/build`.

## Running OpenSBI, bm-app and Linux

Start QEMU and launch the bare-metal application and kernel:

```bash
./output/images/start-qemu-bm-kernel.sh
```

This script compiles and applies the 'hwirq_bind_domain_linux_bmapp.dts' overlay to the dumped QEMU base Devicetree before re-running QEMU.

A representative overlay fragment that binds hart 2 to domain 1 / 2 and routes UART RX (HWIRQ 10) to domain 2 is shown below:

```dts
fragment@0 {
    target-path = "/chosen";

    __overlay__ {
        opensbi-domains {
            compatible = "opensbi,domain,config";
            ...

            domain1: domain1 {
                compatible = "opensbi,domain,instance";
                possible-harts = <0x05 0x03>;
                boot-hart = <0x03>;
                ...
            };

            domain2: domain2 {
                compatible = "opensbi,domain,instance";
                possible-harts = <0x05 0x03>;
                boot-hart = <0x03>;
                ...
            };

            rpmi_sysirq_intc: interrupt-controller {
                compatible = "opensbi,mpxy-sysirq";
                interrupt-controller;
                #interrupt-cells = <1>;
                interrupts-extended =
                    <0x09 10 4>, /* VIRQ 0: UART RX */
                    <0x09 20 4>, /* VIRQ 1: test */
                    <0x09 21 4>; /* VIRQ 2: test */
                opensbi,mpxy-channel-id = <4>;
                opensbi,domain = <&domain2>;
            };
        };
    };
};

fragment@1 {
    target-path = "/cpus/cpu@1";
    __overlay__ {
        opensbi-domain = <&domain1>;
    };
};

fragment@2 {
    target-path = "/cpus/cpu@2";
    __overlay__ {
        opensbi-domain = <&domain1>;
    };
};
```

When the following output appears on the console, QEMU is waiting for a pending connection.

```bash
qemu-system-riscv64: -chardev socket,id=vc0,host=127.0.0.1,port=64321,server=on,wait=on: info: QEMU waiting for connection on: disconnected:tcp:127.0.0.1:64321,server=on
```

Connect to QEMU via a new console by using telnet to port 64321:

```bash
$ telnet 127.0.0.1 64321
```

Linux logs appear on the new console, while the OpenSBI and bare-metal application logs remain on the original console.

In the OpenSBI / bare-metal console, the following logs show VIRQ initialization and route-rule setup:

```text
APLIC: Set target IDC 2 for hwirq 10
APLIC: Set target IDC 2 for hwirq 20
APLIC: Set target IDC 2 for hwirq 21
APLIC: irqchip aplic cold init done
[VIRQ] Init per-domain VIRQ courier state for domain2
[VIRQ] number of harts: 4
[VIRQ] Init per-domain VIRQ courier state for domain1
[VIRQ] number of harts: 4
[VIRQ] set mapping: (hwirq 10, chip_uid 8196) -> VIRQ 0
[VIRQ] add route rule: hwirq 10 route to dom (domain2)
[VIRQ] set mapping: (hwirq 20, chip_uid 8196) -> VIRQ 1
[VIRQ] add route rule: hwirq 20 route to dom (domain2)
[VIRQ] set mapping: (hwirq 21, chip_uid 8196) -> VIRQ 2
[VIRQ] add route rule: hwirq 21 route to dom (domain2)
```

This means:

- HWIRQ 10 (UART RX) maps to VIRQ 0 and routes to domain 2.
- HWIRQ 20 maps to VIRQ 1 and routes to domain 2.
- HWIRQ 21 maps to VIRQ 2 and routes to domain 2.

The VIRQ ECALL extension is then registered:

```text
[ECALL VIRQ] register VIRQ ecall extensions, ret=0
...
Standard SBI Extensions : time,rfnc,ipi,base,hsm,srst,pmu,dbcn,fwft,legacy,dbtr,sse,virq
```

Hart 2 initially boots bm-app1 in domain 1 and enables SEIP on hart 2:

```text
BM-APP (domain 1, hart 2): Welcome to OpenSBI bare-metal app!
BM-APP (domain 1, hart 2): SBI Spec Version: 3.0
BM-APP (domain 1, hart 2): SBI Implementation: OpenSBI
BM-APP (domain 1, hart 2): OpenSBI Version: 1.8
BM-APP (domain 1, hart 2): Init timer successfully 10000000 ticks/s
BM-APP (domain 1, hart 2): SEIP enabled, stvec=88000b08
BM-APP (domain 1, hart 2): Enable UART RX interrupt
BM-APP (domain 1, hart 2): Setup done. Type keys now to trigger UART interrupts.
```

By typing a key such as 'a', the complete APLIC and VIRQ lifecycle can be observed:

1. HWIRQ 10 is asserted and the VIRQ courier handler is invoked.

```text
[APLIC] IDC_TOPI_ID from CLAIMI (hwirq) 10
[IRQCHIP] Calling handler for hwirq 10
[IRQCHIP] Enter hwirq 10 raw handler
[IRQCHIP] Calling hwirq 10 raw handler callback
[VIRQ] virq courier hart2 curr=domain1 target=domain2 hwirq=10
```

2. The interrupt is mapped, routed, and enqueued.

```text
[VIRQ] found existing mapping: (hwirq 10, chip_uid 8196) -> virq 0
[VIRQ] route hwirq 10, chip_uid 8196 -> dom (domain2), channel 4, VIRQ 0
[VIRQ] Get queue for (domain,hartidx): (domain2,2)
[VIRQ] Push VIRQ 0 to queue
```

3. M-mode sets SEIP and switches into the target domain.

```text
[VIRQ] S-mode pending notify
[VIRQ] virq courier switching hart2 domain1 -> domain2
[domain] switch hart2 domain1 -> domain2 (mideleg=0x1666)
[IRQCHIP] Set mip.SEIP (mip before=0x20, after=0x220)
```

4. bm-app2 starts in domain 2 if this is the first entry.

```text
[domain] first-entry domain2 on hart2 (mideleg=0x1666)
BM-APP (domain 2, hart 2): Welcome to OpenSBI bare-metal app!
BM-APP (domain 2, hart 2): SBI Spec Version: 3.0
BM-APP (domain 2, hart 2): SBI Implementation: OpenSBI
BM-APP (domain 2, hart 2): OpenSBI Version: 1.8
BM-APP (domain 2, hart 2): Init timer successfully 10000000 ticks/s
```

5. bm-app2 traps on SEIP and issues POP.

```text
BM-APP (domain 2, hart 2): [VIRQ] SEIP handler trapped
BM-APP (domain 2, hart 2): [VIRQ] Pop IRQ via ecall
```

6. The M-mode ECALL handler pops the pending VIRQ from `q[domain2,hart2]`.

```text
[ECALL VIRQ] VIRQ ecall handler, funcid: 0
[VIRQ] Get queue for (domain,hartidx): (domain2,2)
[VIRQ] Pop VIRQ 0 from queue
```

7. bm-app2 handles the VIRQ and issues COMPLETE.

```text
BM-APP (domain 2, hart 2): [VIRQ] Pop IRQ:0
BM-APP (domain 2, hart 2): [VIRQ] Handle IRQ:0, hwirq:10
BM-APP (domain 2, hart 2): [UART] Got 'a'(0x61)
BM-APP (domain 2, hart 2): [VIRQ] Complete IRQ via ecall
```

8. The M-mode handler completes the VIRQ and calls EOI on the physical IRQ.

```text
[ECALL VIRQ] VIRQ ecall handler, funcid: 1
[VIRQ] Get queue for (domain,hartidx): (domain2,2)
[VIRQ] Complete VIRQ 0 from queue
[IRQCHIP] Calling EOI of hwirq 10
[APLIC] Enter regitered EOI of hwirq 10
```

9. Once the queue is drained, execution returns to the previous domain.

```text
[VIRQ] return_to_prev after VIRQ queue drained on hart2
[domain] return hart2 domain2 -> domain1 (mideleg=0x1666)
[domain] switch hart2 domain2 -> domain1 (mideleg=0x1666)
```

## Linux IRQ Tests

These tests show that APLIC-DIRECT interrupts without explicit routing rules to Linux are not impacted by the VIRQ path.

Linux runs as the next-stage S-mode payload of the root domain on hart 0 / 1. Without explicit root-domain routing rules, HWIRQs used by Linux follow the default fallback behavior and remain handled by the root domain.

In the Linux console, after login as root, check the IRQ status by:

```text
$ watch -n 1 cat /proc/interrupts

Every 1.0s: cat /proc/interrupts 2026-02-23 22:49:38

CPU0 CPU1
10: 1152 1753 RISC-V INTC 5 Edge riscv-timer
12: 16 0 APLIC-DIRECT 33 Level virtio2
14: 512 0 APLIC-DIRECT 7 Level virtio1
15: 271 0 APLIC-DIRECT 8 Level virtio0
16: 0 0 APLIC-DIRECT 11 Level 101000.rtc
IPI0: 62 64 Rescheduling interrupts
IPI1: 236 330 Function call interrupts
IPI2: 0 0 CPU stop interrupts
IPI3: 0 0 CPU stop (for crash dump) interrupts
IPI4: 0 0 IRQ work interrupts
IPI5: 0 0 Timer broadcast interrupts
IPI6: 0 0 CPU backtrace interrupts
IPI7: 0 0 KGDB roundup interrupts
```

The APLIC-DIRECT counters should keep incrementing. Continue pressing keys in the bare-metal console while watching `/proc/interrupts` in Linux; Linux IRQ delivery should remain unaffected.

This demonstrates that VIRQ mapping, routing, and couriering only apply to HWIRQs explicitly bound to a destination domain through Devicetree rules. Other interrupts continue to follow the default root-domain path.

# Upstream Efforts

The patch set was posted to OpenSBI mailing list and ready for review:

[[PATCH 00/10] Introduce Virtual IRQ (VIRQ) framework](https://lore.kernel.org/opensbi/20260514225756.2255758-1-raymondmaoca@gmail.com/)

# Appendix - Programming Interface

## Init / Uninit API

The initialization layer provides `sbi_virq_domain_init()`, `sbi_virq_domain_exit()`, `sbi_virq_init()`, and `sbi_virq_is_inited()`. These APIs initialize per-domain courier state, tear it down, bootstrap the global VIRQ subsystem, and query whether initialization has already completed.

## Mapping API

The mapping layer provides `sbi_virq_map_init()`, `sbi_virq_map_one()`, `sbi_virq_map_set()`, `sbi_virq_map_ensure_cap()`, `sbi_virq_hwirq2virq()`, `sbi_virq_virq2hwirq()`, `sbi_virq_unmap_one()`, and `sbi_virq_map_uninit()`. Together these cover per-channel map creation, stable VIRQ allocation, forward and reverse lookup, explicit assignment, growth, and cleanup.

## Routing API

The routing layer provides `sbi_virq_route_reset()`, `sbi_virq_route_add()`, and `sbi_virq_route_lookup()`. These interfaces reset the rule table, install new HWIRQ-to-domain rules, and resolve the destination domain and MPXY channel for an asserted HWIRQ.

## Courier API

The courier layer provides `sbi_virq_enqueue()`, `sbi_virq_pop_thishart()`, `sbi_virq_complete_thishart()`, `sbi_virq_return_to_prev_if_needed()`, and `sbi_virq_courier_handler()`. These APIs enqueue VIRQs onto per-(domain,hart) queues, let S-mode pop and complete them, handle return-to-previous-domain logic, and expose the IRQCHIP-facing callback used when a host HWIRQ is asserted.
