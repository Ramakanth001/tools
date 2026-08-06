class StorageService:
    def build_upload_url(self, object_key: str) -> str:
        return f"https://storage.local/upload/{object_key}"

    def build_download_url(self, object_key: str) -> str:
        return f"https://storage.local/download/{object_key}"
