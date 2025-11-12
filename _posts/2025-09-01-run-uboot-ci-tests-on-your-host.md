---
layout: post
title: "Run U-Boot CI Pipeline on Your Host"
---

When working on U-Boot’s CI testing infrastructure, sometimes it is
necessary to modify not only the test cases themselves, but also the
surrounding test framework, for example:

  - updating U-Boot Test Hooks (e.g., adding board-specific configs,
    updating board environment setup, or refactoring the shared test
    logic);

  - modifying the Dockerfile used by the CI to build the test
    environment;

  - and then developing or adjusting Pytest test cases or additional
    U-Boot patches that depend on those environment changes.

However, the current U-Boot Azure CI Pipeline enforces a strict flow:
changes to Test Hooks or the Docker environment must first be merged
into upstream before the CI system can use them to validate subsequent
patches. This causes a practical problem:

if your Pytest or board-level test changes depend on adjustments to the
Test Hooks or Docker image, you cannot fully validate them until those
prerequisite changes are full merged. And if during that process you
discover additional prerequisite fixes are needed, you end up with a
back-and-forth cycle of incremental upstream submissions, each requiring
CI time and review round-trips.

This workflow is inefficient, especially for contributors working on
larger test architecture refactoring or adding support for new boards.

To solve this, it is extremely useful to reproduce the U-Boot Azure CI
test flow locally. By mirroring the CI pipeline job on your local host,
you can:

  - modify Test Hooks, Dockerfile, and test logic in one workspace,

  - run the complete test pipeline locally,

  - validate that the environment setup, board configs, and Pytest tests
    behave as expected, and then

  - upstream the changes in logical, minimal, and clean patch series.

Below is a script I converted from the `test_py_wrapper_script`
created and used by Azure CI pipeline job:

[test\_ci\_simulate.sh](https://github.com/raymo200915/azure_uboot_ci_pipeline_test_script/blob/main/test_ci_simulate.sh)

The usage is simple, after you push your Test Hooks changes to your
remote Git branch and finish the update for your local Dockerfile, place
this script into the U-Boot root directory.

Build and run docker image with the new Dockerfile by:

```
sudo docker build --network=host \
-t uboot-ci:<YOUR_TAG> \
-f tools/docker/Dockerfile .

sudo docker run --network=host --rm -it \
-v $PWD:/u-boot \
-w /u-boot \
uboot-ci:<YOUR_TAG>
```

In the docker console, run below command with the board type, board
identity, testcase name you want to test with, plus address / branch
name of your remote test hooks git repository.

```
TEST_PY_BD="<BOARD_TYPE>" TEST_PY_ID="--id <BOARD_ID>" \
TEST_PY_TEST_SPEC="<TESTCASE_NAME>" \
TEST_HOOKS_GIT="<YOUR_TEST_HOOK_GIT_ADDR>" \
TEST_HOOKS_BRANCH="<YOUR_TEST_HOOK_BRANCH_NAME>" \
./test_ci_simulate.sh
```

Below are the default values (which I used to verify the CI enablement
for Firmware Handoff) for each environment if they do not exist in the
command line:

```
TEST_PY_BD="qemu_arm64"
TEST_PY_ID="--id fw_handoff_tfa_optee"
TEST_PY_TEST_SPEC="test_fw_handoff"
TEST_HOOKS_GIT="https://github.com/raymo200915/u-boot-test-hooks.git"
TEST_HOOKS_BRANCH="eventlog_handoff_v2"
```

After you verify your patches locally, you can start to prepare for
upstreaming.

This approach significantly reduces the number of CI retries, shortens
debugging cycles, and gives you confidence that your patches will pass
CI before they are submitted.
