/**
 * Description
 * ===========
 * Bidirectional see-through portal. Two portals can be paired using a shared group name.
 *
 * Usage
 * =======
 * Add two instances of `portal.glb` to the Spoke scene.
 * The name of each instance should look like "some-descriptive-label__group-name"
 *
 * For example, to make a pair of portals to/from the panorama area,
 * you could name them "portal-to__panorama" and "portal-from__panorama"
 */

const worldPos = new THREE.Vector3()
const worldCameraPos = new THREE.Vector3()
const worldDir = new THREE.Vector3()
const worldQuat = new THREE.Quaternion()
const mat4 = new THREE.Matrix4()

const PortalShader = {
  uniforms: {
    cubeMap: { value: null }
  },
  vertexShader: `
    varying vec3 vCameraPosition;
    varying vec3 vPosition;
    varying vec3 vNormal;

    void main() {
      vec4 worldPosH = modelMatrix * vec4(position, 1);
      vCameraPosition = cameraPosition;
      vPosition = worldPosH.xyz / worldPosH.w;
      vNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1);
    }
  `,
  fragmentShader: `
    uniform samplerCube cubeMap;

    varying vec3 vCameraPosition;
    varying vec3 vPosition;
    varying vec3 vNormal;

    void main() {
      vec3 dir = normalize(vPosition - vCameraPosition);
      dir = mix(dir, vNormal, 0.3);
      gl_FragColor = textureCube(cubeMap, dir);
    }
  `
}


AFRAME.registerSystem('portal', {
  dependencies: ['fader-plus'],
  init: function () {
    this.teleporting = false
    this.characterController = this.el.systems['hubs-systems'].characterController
    this.fader = this.el.systems['fader-plus']
  },
  teleportTo: async function (object) {
    this.teleporting = true
    await this.fader.fadeOut()
    // Scale screws up the waypoint logic, so just send position and orientation
    object.getWorldQuaternion(worldQuat)
    object.getWorldDirection(worldDir)
    object.getWorldPosition(worldPos)
    worldPos.add(worldDir) // Teleport in front of the portal to avoid infinite loop
    mat4.makeRotationFromQuaternion(worldQuat)
    mat4.setPosition(worldPos)
    // Using the characterController ensures we don't stray from the navmesh
    this.characterController.travelByWaypoint(mat4, true, false)
    await this.fader.fadeIn()
    this.teleporting = false
  },
})

AFRAME.registerComponent('portal', {
  schema: {
    group: { type: 'string', default: null },
  },
  init: async function () {
    this.system = APP.scene.systems.portal // A-Frame is supposed to do this by default but doesn't?
    this.group = this.data.group ?? this.parseSpokeName()
    this.other = await this.getOther()

    // TODO: Replace this visualization with camera and shader setup
    // Create render target (contains cube texture) and cube camera
    this.cubeRenderTarget = new THREE.WebGLCubeRenderTarget(1024)
    this.cubeCamera = new THREE.CubeCamera(1, 100000, this.cubeRenderTarget)

    // Attach cube camera to object
    this.el.object3D.add(this.cubeCamera)

    // Flag that we need to update the cube camera
    this.needsUpdate = true

    const material = new THREE.ShaderMaterial(PortalShader)
    material.uniforms.cubeMap.value = this.cubeRenderTarget.texture
    this.el.getOrCreateObject3D('mesh').material = material

    // TO DO: Make this pretty
    this.ring = document.createElement('a-sphere')
    this.ring.setAttribute('radius', '1.3')
    this.ring.setAttribute('color', 'black')
    this.ring.setAttribute('side', 'back')
    this.ring.setAttribute('shader', 'flat')
    this.ring.setAttribute('visible', false)
    this.el.appendChild(this.ring)

    // The user's avatar always first in the list of "networked-avatar"s regardless of if
    // they were the first ones to join the Hubs room
    const activeAvatar = document.querySelector("[networked-avatar]")
    this.avatarPos = activeAvatar.object3D.getWorldPosition();

  },
  tick: async function () {
    // On the first frame only, update the camera view AND find the matched destination portal
    if (this.needsUpdate){
      // Make sure cubeCamera position to match that of portals
      this.cubeCamera.position.copy(this.el.object3D.getWorldPosition())

      this.cubeCamera.update( this.el.sceneEl.renderer, this.el.sceneEl.object3D )
      this.ring.setAttribute('visible', true)
      this.findMatchedPortal()

      this.needsUpdate = false
    }

    if (this.other && !this.system.teleporting) {
      this.el.object3D.getWorldPosition(worldPos)
      this.el.sceneEl.camera.getWorldPosition(worldCameraPos)
      const dist = worldCameraPos.distanceTo(worldPos)
      if (dist < 0.5) {
        this.system.teleportTo(this.other.object3D)
      }
    }
  },
  getOther: function () {
    return new Promise((resolve) => {
      const portals = Array.from(document.querySelectorAll(`[portal]`))
      const other = portals.find((el) => el.getAttribute('portal').group === this.data.group && el !== this.el)
      if (other !== undefined) {
        // Case 1: The other portal already exists
        resolve(other)
        other.emit('pair', { other: this.el }) // Let the other know that we're ready
      } else {
        // Case 2: We couldn't find the other portal, wait for it to signal that it's ready
        this.el.addEventListener('pair', (event) => resolve(event.detail.other), { once: true })
      }
    })
  },
  parseSpokeName: function () {
    // Accepted names: "label__group" OR "group"
    const spokeName = this.el.parentEl.parentEl.className
    const group = spokeName.match(/(?:.*__)?(.*)/)[1]
    return group
  },
})
