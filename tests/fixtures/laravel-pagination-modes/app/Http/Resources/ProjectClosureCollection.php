<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectClosureCollection extends ResourceCollection
{
    public $collects = ProjectResource::class;

    public function toArray(Request $request): array
    {
        return [
            'closures' => collect($this->collection)
                ->map(function ($project) {
                    return [
                        'identifier' => $project['id'],
                        'owner' => $project['owner_email'],
                        'label' => 'closure-project',
                    ];
                })
                ->filter(function ($project) {
                    return $project['owner'];
                })
                ->values()
                ->all(),
        ];
    }
}
