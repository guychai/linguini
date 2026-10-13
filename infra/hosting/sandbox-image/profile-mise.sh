# Login shells (the user terminal runs `bash -l`): Alpine's /etc/profile resets PATH; put the
# mise shims back in front so node/python/etc. resolve like in the bash tool.
export MISE_DATA_DIR=/opt/mise MISE_CACHE_DIR=/var/cache/mise MISE_YES=1
case ":$PATH:" in *:/opt/mise/shims:*) ;; *) PATH="/opt/mise/shims:$PATH" ;; esac
export PATH
