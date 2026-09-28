//go:build !wasip1

package main

// 非 wasip1 平台(本地 go test / go vet)的占位实现:
// 真实的 host_call / host_read 由 wasip1 构建下的 //go:wasmimport 提供。
// 本文件不进 wasm 产物, 只让包能在本机编译和跑单元测试。

func host_call(ptr, length uint32) uint32 { return 0 }

func host_read(ptr, length uint32) uint32 { return 0 }
