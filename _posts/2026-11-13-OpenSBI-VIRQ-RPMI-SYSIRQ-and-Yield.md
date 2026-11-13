---
layout: post
title: "RISC-V: Updating OpenSBI VIRQ with RPMI SYSTEM_IRQ and Yield"
---
# Overview

In the [previous post](/2026/05/08/Virtual-IRQ-Mapping-Routing-and-Couriering-in-OpenSBI.html),
I outlined an OpenSBI Virtual IRQ (VIRQ) system to route physical interrupts
for S-mode payloads in different domains. The first design was based on a
private SBI extension to pop and complete VIRQs.

Since then I have made some modifications to the design and now v2 is ready.
The new version combines the VIRQ framework with the RPMI SYSTEM_IRQ.
service group over SBI MPXY and includes an experimental Yield ECALL as an option.
It also enhances interrupt routing, domain switching and initialization.

# From Private ECALLs to RPMI SYSTEM_IRQ

The VIRQ original design provided two private operations to its S-mode payload:
Use `POP` to get a pending VIRQ and `COMPLETE` to complete it. In v2,
the payload claims interrupts via the service RPMI SYSTEM_IRQ service group
over an MPXY(Message Proxy) channel.

The following is a list of SYSTEM_IRQ support implemented in the v2 series:

- `GET_ATTRIBUTES`
- `GET_TARGET_ATTRIBUTES`
- `GET_IRQ_ATTRIBUTES`
- `SYSIRQ_CLAIM`

The service layer exposes backend callbacks for claiming interrupts for
connecting the protocol interface to the domain-aware VIRQ courier.
Target indices enumerate possible harts. A claim may only be made by the calling
domain and hart.

There is a different VIRQ namespace for each MPXY channel. OpenSBI still owns
the physical interrupt and maps it to a channel-local VIRQ, but now he S-mode
payload claims pending interrupts in batches using `SYSIRQ_CLAIM`.

## Claim and Completion

A claimed interrupt does not get completed when it is returned to the payload.
The physical source remains masked when the payload handles and clears the
device condition. In this implementation, the next valid `SYSIRQ_CLAIM`
completes the previously claimed batch. That means a payload must finish
handling the previous batch before claiming for the next.

# Experimental Yield ECALL

Optionaly, a payload can use Yield explicitly following the processing of the
claimed interrupts. Yield completes SYSIRQ batches for the calling domain and
hart without claiming a new batch.

Yield uses an extension ID of `0x0800594c` and a function ID of `0`.
The extension is controlled by `CONFIG_SBI_ECALL_YIELD`. It is registered only
if there are SYSIRQ channels.

# Interrupt Flow

Interrupt handling flow is still domain-aware, while the boundary between layers
has shifted:

```text
Physical interrupt (for example, UART RX)
  -> M-mode irqchip claims the HWIRQ
  -> OpenSBI maps (irqchip, HWIRQ) to a VIRQ under a specific MPXY channel
  -> mask the source and enqueue the VIRQ for the target domain / hart
  -> switch to the target domain if necessary and notify it through SEIP
  -> S-mode uses MPXY / SYSIRQ_CLAIM to claim a batch
  -> payload handles the devices and clears their interrupt conditions
  -> the next CLAIM completes the previous batch and claims more work,
     or Yield explicitly completes without a new claim
  -> when pending and claimed work are drained, OpenSBI return to the previous
     domain if necessary
```

# Device Tree Binding for Interrupt Mapping and Routing

Mapping and routing model remains unchanged in v2. It uses `opensbi,mpxy-sysirq`
nodes under `/chosen/opensbi-domains`. For example:

```dts
sysirq {
    compatible = "opensbi,mpxy-sysirq";
    interrupt-controller;
    #interrupt-cells = <1>;
    opensbi,mpxy-channel-id = <4>;
    opensbi,domain = <&tdomain>;
    interrupts-extended = <&aplic_m 10 4>;
};
```

Entry order in `interrupts-extended` represents the VIRQ number of that MPXY
channel. It starts from zero.

The last cell represents the interrupt flags. Each physical source belongs to
one channel only.

Routing policies are keyed by the interrupt-controller identity and HWIRQ number.
So the same HWIRQ number on different controllers describes two distinct sources.

Above example shows the mapping from HWIRQ 10 to VIRQ 0 in channel 4 and routing
to `tdomain` domain. 

# Validation and Upstream status

All changes in v2 belong to the RISE RP022 work and they are available at
[RISE Gitlab OpenSBI RP022-M1 branch](https://gitlab.com/riseproject/riscv-optee/opensbi/-/tree/rp022-m1).
Documentation and test instructions are available at
[RISE RP022-M1 page](https://riscv-optee-docs-c9fea0.gitlab.io/rp022/milestone1/).
VIRQ v2 series has been submitted to the OpenSBI mailing list and is available at
[[PATCH v2 00/12] Introduce Virtual IRQ (VIRQ) framework](https://lore.kernel.org/opensbi/20261029155929.586597-1-raymondmaoca@gmail.com/).

The key difference is that v2 validates by using the `SYSIRQ_CLAIM` and batch
completion convention, or explicit Yield after handling, replacing the legacy
`POP` and `COMPLETE` ecalls being used in v1.
