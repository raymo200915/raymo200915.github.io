---
layout: post
title: "Enhancing U-Boot SMBIOS on Arm64: Full Support for System, Board, CPU, and Memory Tables"
---
# Overview

System Management BIOS (SMBIOS) is an industry standard that defines a structured way for firmware to expose hardware and system information to the operating system.
Through SMBIOS tables, firmware can describe details such as the system manufacturer, board information, processor configuration, memory layout, and slot topology — all without relying on device-specific probing or vendor-specific interfaces.

On Linux systems, distro tooling and system management utilities such as dmidecode, lshw, fwupd, and systemd-hwdb depend on SMBIOS data to identify platforms, enable firmware update mechanisms, and collect system inventory for analytics or compliance.
When U-Boot is used as the boot firmware on embedded or virtualized Arm platforms, providing accurate SMBIOS tables becomes essential for integration with modern Linux distributions and their infrastructure tooling.

Historically, U-Boot had limited SMBIOS support.
Before my work, it only implemented a minimal set of types — primarily Type #0 to Type #4 (BIOS, System, Baseboard, Chassis, and Processor Information).
Even within these, many fields were hard-coded placeholder values (e.g., “U-Boot” as manufacturer, or fixed slot numbers and memory sizes) instead of reflecting the actual hardware configuration obtained from the Device Tree or runtime data.

This limitation caused issues for systems expecting realistic SMBIOS data — for instance, when Linux userspace tools tried to query memory topology, system slots, or CPU configuration, they would often receive incomplete or inaccurate information.

To address this gap, I extended U-Boot’s SMBIOS implementation to support all mandatory structures (Type #0 ~ #4 / #7 / #9 / #16 / #17 / #19) covering System, Baseboard, Chassis, Processor, Cache, System Slot, Physical Memory Array, Memory Device, and Memory Array Mapped Address.
My goal was to make SMBIOS generation dynamic and data-driven, extracting real platform information from the Device Tree and other subsystems, ensuring that downstream Linux tools can correctly recognize and manage U-Boot-based platforms just like any PC or server firmware.

# Implementation Epic

What was missing in U-Boot's SMBIOS Library:

- Missing support for other mandatory types (#7, #9, #16, #17, #19).

- Only a few platforms support the SMBIOS subtree \[1\].

- Values of some fields are hardcoded in the library other than fetching from the device hardware.

- Embedded data with dynamic length is not supported (E.g. Contained Object Handles in Type #2 and Contained Elements in Type #3)

Design Goals:

- Align the format of SMBIOS tables with the specification.

- Fetch SMBIOS elements based on the following priority (if the corresponding interface is available):

  - From the sysinfo driver, which reads hardware information directly and converts it into SMBIOS-compatible format.

  - From explicit definitions under the SMBIOS subtree \[1\] in the Device Tree.

    Properties follow the SMBIOS specification using lowercase
    hyphen-separated names.

  - Fallback to scan the entire Device Tree, locate relevant information, and convert it into the SMBIOS-required format.

- To minimize size-growth for those platforms which have not sufficient ROM spaces or do not need detailed SMBIOS information, building with new added type structures / properties / sysinfo drivers should be under kconfig control.

## Step 1 - Refactored SMBIOS Library to Improve the Existing Support (Type #0 ~ #4)

- Aligned existing elements (Type #0 ~ #4) with the latest specification.

- Created sysinfo driver to populate platform private data.

- Created an arch-specific driver to fetch CPU data for all Arm64-based platforms, and registered it to the sysinfo driver.

- Added generic SMBIOS DTS file for Arm64 platforms \[2\] representing the SMBIOS subtree \[1\].

- Refactored wrapper function `smbios_get_val_si()` and `smbios_add_prop_si()`, which act as wrappers on top of the sysinfo driver, and retrieves SMBIOS system information follow the priority "sysinfo driver (hardware information) -> SMBIOS subtree \[1\] subnodes -> entire Device Tree".

- New kconfig `GENERATE_SMBIOS_TABLE_VERBOSE` was introduced to include / exclude new structures / properties.

## Step 2 - Introduced Cache Information (Type #7) Support

- An arch-specific driver was created for all Arm64-based platforms to fetch cache data via sysinfo driver.

- Implemented all Type #7 required elements through `smbios_get_val_si()` and `smbios_add_prop_si()`, and link the handles to Type #4.

- Added Type #7 support into U-Boot console.

- Support for generating Type #7 table was introduced using a hybrid approach:

  - Sysinfo driver always takes precedence to fetch and translate cache information from hardware platform.

  - For an element that sysinfo driver is not available, explicit definitions in SMBIOS subtree \[1\] work instead:

    Child node under `/smbios/smbios/cache` \[3\] will be interpreted as individual cache definitions.
    Each child node name `l<n>-cache` represents level\<n\> of cache.

    Properties follow the SMBIOS specification using lowercase
    hyphen-separated names such as `supported-sram-type`,
    `error-correction-type`, `system-cache-type`, etc.

    This method supports precise platform-defined overrides and system
    descriptions.

  - Fallback to automatic discovery from the entire Device Tree.

- The support for Type #7 is under control by kconfig `GENERATE_SMBIOS_TABLE_VERBOSE`.

## Step 3 - Introduced System Slot (Type #9) Support

- Implemented all Type #9 required elements through `smbios_get_val_si()` and `smbios_add_prop_si()`.

- Support for generating Type #9 table was introduced using a hybrid approach:

  - No sysinfo driver as Type #9 information is DT-based.

  - Explicit definitions in SMBIOS subtree \[1\] takes precedence:

    Child node under `/smbios/smbios/system-slot` \[4\] will interpreted as individual slot definitions.
    Each child node name (e.g., `isa`, `pcmcia`, etc.) represents a type of slot.

    Properties follow the SMBIOS specification using lowercase
    hyphen-separated names such as `slot-type`, `slot-id`,
    `segment-group-number`, `bus-number`, `slot-information`, etc.

    This approach allows full customization of each system slot and is
    especially suitable for platforms with well-defined slot topology.

  - Fallback to automatic discovery from the entire Device Tree:

    If child node under `/smbios/smbios/system-slot` does not exist, the implementation will:

    - scan the entire Device Tree for nodes whose `device_type` matches known slot-related types (`pci`, `isa`, `pcmcia`, etc.).

    - When a match is found, default values or heuristics are applied to populate the System Slot table.

    This mode is useful for platforms that lack explicit SMBIOS nodes
    but still expose slot topology via standard Device Tree conventions.

  Together, two approaches ensure that Type #9 entries are available
  whether explicitly described or automatically derived.

- The support for Type #9 is under control by kconfig `GENERATE_SMBIOS_TABLE_VERBOSE`.

## Step 4 - Introduced Memory Related (Type #16 / #17 / #19) Support

- Implemented all required elements for Physical Memory Array (Type #16), Memory Device (Type #17) and Memory Array Mapped Address (Type #19) through `smbios_get_val_si()` and `smbios_add_prop_si()`.

- Support for generating Type #16 / #17 / #19 tables was introduced using a hybrid approach:

  - No sysinfo driver as Type #16 / #17 / #19 information are all DT-based.

  - Explicit definitions in SMBIOS subtree \[1\] takes precedence:

    Child node under `/smbios/smbios/memory-array` \[5\], `/smbios/smbios/memory-device` \[6\], or `/smbios/smbios/memory-array-mapped-address` \[7\] be interpreted to corresponding SMBIOS tables directly.

    Properties follow the SMBIOS specification using lowercase
    hyphen-separated names (e.g., `memory-error-correction`,
    `physical-memory-array-handle`, `starting-address`, etc.).

    This method supports precise platform-defined overrides and system
    descriptions.

  - Fallback to automatic discovery from the entire Device Tree:

    If the relevant child nodes are missing, the implementation will:

    - Scan all top-level `memory@` nodes \[8\] (`device_type = "memory"`) to populate Type #16 / #17 / #19 with inferred size and location data.

    - Scan nodes named or marked as `memory-controller` \[9\] and parse associated `dimm@` child nodes (if present) to extract DIMM sizes and map them accordingly.

  This dual-mode support enables flexible firmware SMBIOS reporting while
  aligning with spec-compliant naming and runtime-detected memory topology.

- The supports for Type #16 / #17 / #19 are all under control by kconfig `GENERATE_SMBIOS_TABLE_VERBOSE`.

# Patch Series Links

- Improvement for Type #0 ~ #4, implementation of Type #7:

  [\[PATCH v3 00/10\] SMBIOS improvements](https://lore.kernel.org/u-boot/20241206225438.13866-1-raymond.mao@linaro.org/)

- Implementation of Type #9 and bug-fix (upstream in progress):

  [\[PATCH v3 1/2\] smbios: Fix duplicated smbios handles](https://lore.kernel.org/u-boot/20250919205605.291108-1-raymond.mao@linaro.org/)

  [\[PATCH v3 2/2\] smbios: add support for dynamic generation of Type 9 system slot tables](https://lore.kernel.org/u-boot/20250919205605.291108-2-raymond.mao@linaro.org/)

- Implementation of Type #16 / #17 / #19:

  \[WIP\]

# Reference

\[1\] SMBIOS subtree layout:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    smbios {
      system {
        ...
      };
      baseboard {
        ...
      };
      chassis {
        ...
      };
      processor {
        ...
      };
      cache {
        ...
      };
      system-slot {
        ...
      };
      memory-array {
        ...
      };
      memory-device {
        ...
      };
      memory-array-mapped-address {
        ...
      };
    };
  };
};
```

\[2\] arch/arm/dts/smbios_generic.dtsi

\[3\] `cache` child node layout example with 2-level cache:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    ...
    smbios {
      ...
      cache {
        l1-cache {
          socket-design = "";
          config = <(SMBIOS_CACHE_LEVEL_1 | SMBIOS_CACHE_ENABLED | SMBIOS_CACHE_OP_WB)>;
          max-size = <0>;
          installed-size = <0>;
          supported-sram-type = <SMBIOS_CACHE_SRAM_TYPE_UNKNOWN>;
          speed = <0>;
          error-correction-type = <SMBIOS_CACHE_ERRCORR_UNKNOWN>;
          system-cache-type = <SMBIOS_CACHE_SYSCACHE_TYPE_UNKNOWN>;
          associativity = <SMBIOS_CACHE_ASSOC_UNKNOWN>;
          max-size2 = <0>;
          installed-size2 = <0>;
        };
        l2-cache {
          socket-design = "";
          config = <(SMBIOS_CACHE_LEVEL_2 | SMBIOS_CACHE_ENABLED | SMBIOS_CACHE_OP_WB)>;
          max-size = <0>;
          installed-size = <0>;
          supported-sram-type = <SMBIOS_CACHE_SRAM_TYPE_UNKNOWN>;
          speed = <0>;
          error-correction-type = <SMBIOS_CACHE_ERRCORR_UNKNOWN>;
          system-cache-type = <SMBIOS_CACHE_SYSCACHE_TYPE_UNKNOWN>;
          associativity = <SMBIOS_CACHE_ASSOC_UNKNOWN>;
          max-size2 = <0>;
          installed-size2 = <0>;
        };
      };
      ...
    }
  };
};
```

\[4\] `system-slot` child node layout example with 1 ISA slot and 1 PCMCIA slot:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    ...
    smbios {
      ...
      system-slot {
        isa {
          socket-design = "";
          slot-type = <SMBIOS_SYSSLOT_TYPE_ISA>;
          slot-data-bus-width = <SMBIOS_SYSSLOT_WIDTH_16BIT>;
          current-usage = <SMBIOS_SYSSLOT_USAGE_NA>;
          slot-length = <SMBIOS_SYSSLOT_LENG_SHORT>;
          slot-id = <0>;
          slot-characteristics-1 = <(SMBIOS_SYSSLOT_CHAR_5V | SMBIOS_SYSSLOT_CHAR_3_3V)>;
          slot-characteristics-2 = <SMBIOS_SYSSLOT_CHAR_ASYNCRM>;
          segment-group-number = <0>;
          bus-number = <0>;
          device-function-number = <0>;
          data-bus-width = <0>;
          peer-grouping-count = <0>;
          slot-information = <0>;
          slot-physical-width = <0>;
          slot-pitch = <0>;
          slot-height = <0>;
        };
        pcmcia {
          socket-design = "";
          slot-type = <SMBIOS_SYSSLOT_TYPE_PCMCIA>;
          slot-data-bus-width = <SMBIOS_SYSSLOT_WIDTH_32BIT>;
          current-usage = <SMBIOS_SYSSLOT_USAGE_AVAILABLE>;
          slot-length = <SMBIOS_SYSSLOT_LENG_SHORT>;
          slot-id = <1>;
          slot-characteristics-1 = <(SMBIOS_SYSSLOT_CHAR_5V | SMBIOS_SYSSLOT_CHAR_3_3V)>;
          slot-characteristics-2 = <SMBIOS_SYSSLOT_CHAR_ASYNCRM>;
          segment-group-number = <1>;
          bus-number = <0>;
          device-function-number = <0>;
          data-bus-width = <0>;
          peer-grouping-count = <0>;
          slot-information = <0>;
          slot-physical-width = <0>;
          slot-pitch = <0>;
          slot-height = <0>;
        };
      };
      ...
    }
  };
};
```

\[5\] `memory-array` child node layout example with 2 arrays:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    ...
    smbios {
      ...
      memory-array {
        array@0 {
          location = <SMBIOS_MA_LOCATION_MOTHERBOARD>;
          use = <SMBIOS_MA_USE_SYSTEM>;
          memory-error-correction = <SMBIOS_MA_ERRCORR_SBITECC>;
          maximum-capacity = <0x80000000>;
          memory-error-information-handle = <SMBIOS_MA_ERRINFO_NONE>;
          number-of-memory-devices = <2>;
          extended-maximum-capacity = <0x00000001 0x00000000>; // 4GB <hi32bit=1 lo32bit=0>
        };
        array@1 {
          location = <SMBIOS_MA_LOCATION_OTHER>;
          use = <SMBIOS_MA_USE_NVRAM>;
          memory-error-correction = <SMBIOS_MA_ERRCORR_CRC>;
          maximum-capacity = <0x80000000>;
          memory-error-information-handle = <SMBIOS_MA_ERRINFO_NONE>;
          number-of-memory-devices = <1>;
          extended-maximum-capacity = <0x00000001 0x00000000>; // 4GB <hi32bit=1 lo32bit=0>
        };
      };
      ...
    }
  };
};
```

\[6\] `memory-device` child node layout example with 2 arrays:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    ...
    smbios {
      ...
      memory-device {
        device@0 {
          physical-memory-array-handle = <0>;
          memory-error-information-handle = <SMBIOS_MD_ERRINFO_NONE>;
          total-width = <0>;
          data-width = <0>;
          size = <SMBIOS_MD_SIZE_UNKNOWN>;
          form-factor = <SMBIOS_MD_FF_UNKNOWN>;
          device-set = <SMBIOS_MD_DEVSET_UNKNOWN>;
          device-locator = "";
          bank-locator = "";
          memory-type = <SMBIOS_MD_TYPE_UNKNOWN>;
          type-detail = <SMBIOS_MD_TD_UNKNOWN>;
          speed = <SMBIOS_MD_SPEED_UNKNOWN>;
          manufacturer = "";
          serial-number = "";
          asset-tag = "";
          part-number = "";
          attributes = <SMBIOS_MD_ATTR_RANK_UNKNOWN>;
          extended-size = <0>;
          configured-memory-speed	= <SMBIOS_MD_CONFSPEED_UNKNOWN>;
          minimum-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          maximum-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          configured-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          memory-technology = <SMBIOS_MD_TECH_UNKNOWN>;
          memory-operating-mode-capability = <SMBIOS_MD_OPMC_UNKNOWN>;
          firmware-version = "";
          module-manufacturer-id = <0>;
          module-product-id = <0>;
          memory-subsystem-controller-manufacturer-id = <0>;
          memory-subsystem-controller-product-id = <0>;
          non-volatile-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          volatile-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          cache-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          logical-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          extended-speed = <0>;
          extended-configured-memory-speed = <0>;
          pmic0-manufacturer-id = <0>;
          pmic0-revision-number = <0>;
          rcd-manufacturer-id = <0>;
          rcd-revision-number = <0>;
        };
        device@1 {
          physical-memory-array-handle = <0>;
          memory-error-information-handle = <SMBIOS_MD_ERRINFO_NONE>;
          total-width = <0>;
          data-width = <0>;
          size = <SMBIOS_MD_SIZE_UNKNOWN>;
          form-factor = <SMBIOS_MD_FF_UNKNOWN>;
          device-set = <SMBIOS_MD_DEVSET_UNKNOWN>;
          device-locator = "";
          bank-locator = "";
          memory-type = <SMBIOS_MD_TYPE_UNKNOWN>;
          type-detail = <SMBIOS_MD_TD_UNKNOWN>;
          speed = <SMBIOS_MD_SPEED_UNKNOWN>;
          manufacturer = "";
          serial-number = "";
          asset-tag = "";
          part-number = "";
          attributes = <SMBIOS_MD_ATTR_RANK_UNKNOWN>;
          extended-size = <0>;
          configured-memory-speed	= <SMBIOS_MD_CONFSPEED_UNKNOWN>;
          minimum-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          maximum-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          configured-voltage = <SMBIOS_MD_VOLTAGE_UNKNOWN>;
          memory-technology = <SMBIOS_MD_TECH_UNKNOWN>;
          memory-operating-mode-capability = <SMBIOS_MD_OPMC_UNKNOWN>;
          firmware-version = "";
          module-manufacturer-id = <0>;
          module-product-id = <0>;
          memory-subsystem-controller-manufacturer-id = <0>;
          memory-subsystem-controller-product-id = <0>;
          non-volatile-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          volatile-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          cache-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          logical-size = <SMBIOS_MD_PORT_SIZE_UNKNOWN_HI SMBIOS_MD_PORT_SIZE_UNKNOWN_LO>;
          extended-speed = <0>;
          extended-configured-memory-speed = <0>;
          pmic0-manufacturer-id = <0>;
          pmic0-revision-number = <0>;
          rcd-manufacturer-id = <0>;
          rcd-revision-number = <0>;
        };
      };
      ...
    }
  };
};
```

\[7\] `memory-array-mapped-address` child node layout example with 2 address entries:

```
/ {
  smbios {
    compatible = "u-boot,sysinfo-smbios";
    ...
    smbios {
      ...
      memory-array-mapped-address {
        ma@0 {
          starting-address = <0x00001000>;
          ending-address = <0x00002000>;
          memory-array-handle = <0>;
          partition-width = <0>;
          extended-starting-address = <0>;
          extended-ending-address = <0>;
        };
        ma@1 {
          starting-address = <0xFFFFFFFF>;
          ending-address = <0xFFFFFFFF>;
          memory-array-handle = <0>;
          partition-width = <0>;
          extended-starting-address = <0x00000001 0x00000000>;
          extended-ending-address = <0x00000001 0xffffffff>;
        };
      };
      ...
    }
  };
};
```

\[8\] Example of `memory` Device Tree nodes

```
memory@80000000 {
  device_type = "memory";
  reg = <0x0 0x80000000 0x0 0x40000000>; // 1GB
};
```

\[9\] Example of `memory-controller` Device Tree nodes

```
memory-controller@f0000000 {
  compatible = "test,memory-controller";
  ecc-enabled;
  dimm@0 { size = <0x1 0x00000000>; }; // 4GB <hi32bit=1 lo32bit=0>
  dimm@1 { size = <0x2 0x00000000>; }; // 8GB <hi32bit=2 lo32bit=0>
};
```
