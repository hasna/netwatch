# @hasna/netwatch

Live network traffic monitor — track data usage per interface with process breakdown

[![npm](https://img.shields.io/npm/v/@hasna/netwatch)](https://www.npmjs.com/package/@hasna/netwatch)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/netwatch
```

## CLI Usage

```bash
netwatch --help
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service netwatch
cloud sync pull --service netwatch
```

## Data Directory

Data is stored in `~/.hasna/netwatch/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
