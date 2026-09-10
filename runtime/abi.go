package main

import "unsafe"

// dian115:wasm@1 ABI (Go 官方 wasip1 -buildmode=c-shared)

//go:wasmimport dian115 host_call
func host_call(ptr, length uint32) uint32

//go:wasmimport dian115 host_read
func host_read(ptr, length uint32) uint32

//go:wasmexport dian115_alloc
func dian115_alloc(size uint32) uint32 {
	buf := make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(&buf[0])))
}

//go:wasmexport dian115_handle
func dian115_handle(ptr, length uint32) uint64 {
	req := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	local := make([]byte, length)
	copy(local, req)
	resp := wasmDispatch(local)
	out := make([]byte, len(resp))
	copy(out, resp)
	return uint64(uint32(uintptr(unsafe.Pointer(&out[0]))))<<32 | uint64(len(out))
}
